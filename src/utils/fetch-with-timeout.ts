/**
 * Wraps the native `fetch` with an AbortController-based timeout.
 * If the request doesn't complete within `ms` milliseconds it is aborted
 * and an error is thrown: "Request to <url> timed out after <ms>ms"
 *
 * Default timeout: 30 seconds — covers slow Confluence/Jira/Google instances
 * without blocking the Node process indefinitely on a stalled connection.
 */
export async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    ms = 30_000,
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
        if ((err as Error).name === "AbortError") {
            throw new Error(`Request to ${url} timed out after ${ms}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}
