import { isValidSessionId } from "../../src/services/knowledge/session-identity";
import { slackOwnerId, slackSessionId, slackSessionRef } from "../../src/slack/slack-identity";

describe("Slack identity", () => {
    it("scopes the owner to the user within their workspace", () => {
        expect(slackOwnerId("T01", "U42")).toBe("slack#T01#U42");
    });

    it("derives the same session for every message in a thread", () => {
        expect(slackSessionId("C9", "1727086500.000100")).toBe(slackSessionId("C9", "1727086500.000100"));
    });

    it("keeps the session-id contract: sortable timestamp first, no '#'", () => {
        const id = slackSessionId("C9", "1727086500.000100");
        expect(id).toBe("20240923T101500Z-C9-000100");
        expect(isValidSessionId(id)).toBe(true);
    });

    it("sorts later threads after earlier ones", () => {
        expect(slackSessionId("C9", "1727086500.000100") < slackSessionId("C1", "1727090000.000001")).toBe(true);
    });

    it("distinguishes threads started in the same second in different channels", () => {
        expect(slackSessionId("C1", "1727086500.000100")).not.toBe(slackSessionId("C2", "1727086500.000100"));
    });

    it("rejects something that is not a Slack timestamp", () => {
        expect(() => slackSessionId("C1", "not-a-ts")).toThrow();
    });

    it("builds a full session ref", () => {
        expect(slackSessionRef({ teamId: "T1", userId: "U1", channelId: "D1", threadTs: "1727086500.000100" })).toEqual(
            {
                ownerId: "slack#T1#U1",
                sessionId: "20240923T101500Z-D1-000100",
            },
        );
    });
});
