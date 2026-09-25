/**
 * Wraps the native `fetch` with an AbortController-based timeout, plus a small retry/backoff
 * layer for transient failures (429 rate limits, 5xx server errors) — without this, a single
 * 429 from Atlassian or Google fails the caller outright instead of costing it a short wait.
 *
 * The timeout covers the *entire* request lifecycle — both header resolution
 * and body consumption (.json(), .text(), .arrayBuffer()).  The AbortController
 * timer is only cleared after the body method returns (or throws), so a stalled
 * mid-body transfer (e.g. a large DOCX download) is correctly aborted.
 *
 * Default timeout: 30 seconds — covers slow Confluence/Jira/Google instances
 * without blocking the Node process indefinitely on a stalled connection.
 */

import { getLogger } from "log4js";

const logger = getLogger("FetchWithTimeout");

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Longest a single retry waits, whatever Retry-After asks for. A server may legally ask for an
 * hour, and a CLI that sleeps that long with nothing on screen looks hung. Past this cap the retry
 * most likely meets another 429, and once retries run out that response goes back to the caller,
 * which reports it — a clear failure rather than an unexplained stall.
 */
const MAX_RETRY_DELAY_MS = 30_000;

/** Waits at least this long are logged at warn rather than debug, so they show without --debug. */
const NOTICEABLE_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a Retry-After header (seconds, or an HTTP date) into a millisecond delay, or null. */
function parseRetryAfterMs(response: Response): number | null {
    const header = response.headers.get("retry-after");
    if (!header) return null;

    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

    return null;
}

async function fetchOnce(url: string, init: RequestInit, ms: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    // Don't let this timer alone keep the Node process alive — if all real work is done and this
    // is the only pending handle, the CLI should exit immediately rather than wait out the timeout.
    timeoutId.unref?.();

    try {
        const rawResponse = await fetch(url, { ...init, signal: controller.signal });

        // Wrap body-consuming methods so the abort timer stays alive during body reads.
        const wrapBodyMethod = <T>(fn: () => Promise<T>): Promise<T> =>
            fn().then(
                (result) => {
                    clearTimeout(timeoutId);
                    return result;
                },
                (err: unknown) => {
                    clearTimeout(timeoutId);
                    if ((err as Error).name === "AbortError") {
                        throw new Error(`Request to ${url} timed out after ${ms}ms (during body read)`);
                    }
                    throw err;
                },
            );

        return new Proxy(rawResponse, {
            get(target, prop) {
                if (prop === "json") return () => wrapBodyMethod(() => target.json());
                if (prop === "text") return () => wrapBodyMethod(() => target.text());
                if (prop === "arrayBuffer") return () => wrapBodyMethod(() => target.arrayBuffer());
                if (prop === "blob") return () => wrapBodyMethod(() => target.blob());

                const value = Reflect.get(target, prop);
                if (typeof value === "function") {
                    return value.bind(target);
                }
                return value;
            },
        });
    } catch (err) {
        clearTimeout(timeoutId);
        if ((err as Error).name === "AbortError") {
            throw new Error(`Request to ${url} timed out after ${ms}ms`);
        }
        throw err;
    }
}

export async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    ms = 30_000,
    maxRetries = DEFAULT_MAX_RETRIES,
): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        const response = await fetchOnce(url, init, ms);

        const isRetryable = response.status === 429 || response.status >= 500;
        if (!isRetryable || attempt >= maxRetries) {
            return response;
        }

        const requestedMs = parseRetryAfterMs(response) ?? DEFAULT_BASE_DELAY_MS * 2 ** attempt;
        const delayMs = Math.min(requestedMs, MAX_RETRY_DELAY_MS);
        const capped = requestedMs > delayMs ? ` (server asked for ${requestedMs}ms, capped)` : "";
        const message = `HTTP ${response.status} from ${url} — retrying in ${delayMs}ms (retry ${attempt + 1} of ${maxRetries})${capped}`;
        if (delayMs >= NOTICEABLE_RETRY_DELAY_MS) {
            logger.warn(message);
        } else {
            logger.debug(message);
        }
        await sleep(delayMs);
    }
}
