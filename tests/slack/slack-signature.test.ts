import { createHmac } from "crypto";
import { verifySlackSignature } from "../../src/slack/slack-signature";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather";
const now = 1_531_420_618;

function sign(timestamp: string, payload = body, key = secret): string {
    return `v0=${createHmac("sha256", key).update(`v0:${timestamp}:${payload}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
    const valid = {
        signingSecret: secret,
        body,
        timestamp: String(now),
        signature: sign(String(now)),
        nowSeconds: now,
    };

    it("accepts a correctly signed, fresh request", () => {
        expect(verifySlackSignature(valid)).toBe(true);
    });

    it("rejects a tampered body", () => {
        expect(verifySlackSignature({ ...valid, body: `${body}&extra=1` })).toBe(false);
    });

    it("rejects a signature made with another secret", () => {
        expect(verifySlackSignature({ ...valid, signature: sign(String(now), body, "other") })).toBe(false);
    });

    it("rejects a replay older than five minutes", () => {
        expect(verifySlackSignature({ ...valid, nowSeconds: now + 5 * 60 + 1 })).toBe(false);
    });

    it("rejects missing headers or an empty secret instead of skipping the check", () => {
        expect(verifySlackSignature({ ...valid, signature: undefined })).toBe(false);
        expect(verifySlackSignature({ ...valid, timestamp: undefined })).toBe(false);
        expect(verifySlackSignature({ ...valid, signingSecret: "" })).toBe(false);
    });

    it("rejects a signature of the wrong length without throwing", () => {
        expect(verifySlackSignature({ ...valid, signature: "v0=abc" })).toBe(false);
    });
});
