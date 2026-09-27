import { createHmac, timingSafeEqual } from "crypto";

/** Slack's own tolerance: a request older than this is treated as a replay. */
export const MAX_REQUEST_AGE_SECONDS = 5 * 60;

/**
 * Verifies a request really came from Slack.
 *
 * The ingress URL is public and unauthenticated at the gateway, so this check is the
 * authentication: HMAC-SHA256 of "v0:<timestamp>:<raw body>" with the app's signing secret,
 * compared in constant time, and rejected if the timestamp is stale.
 *
 * `body` must be the raw request body exactly as received — re-serialising parsed JSON changes
 * the bytes and fails every check.
 *
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(params: {
    signingSecret: string;
    body: string;
    timestamp: string | undefined;
    signature: string | undefined;
    nowSeconds?: number;
}): boolean {
    const { signingSecret, body, timestamp, signature } = params;
    if (!signingSecret || !timestamp || !signature) return false;

    const requestSeconds = Number(timestamp);
    const nowSeconds = params.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(requestSeconds) || Math.abs(nowSeconds - requestSeconds) > MAX_REQUEST_AGE_SECONDS) {
        return false;
    }

    const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(signature, "utf8");
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
