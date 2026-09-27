import { isConversationAllowed, readSlackSettings } from "../../src/slack/slack-settings";

describe("readSlackSettings", () => {
    it("defaults to answering everywhere the bot is installed, with two attempts", () => {
        const settings = readSlackSettings({});
        expect(settings.access.allowedTeamIds.size).toBe(0);
        expect(settings.access.allowedChannelIds.size).toBe(0);
        expect(settings.access.allowDirectMessages).toBe(true);
        expect(settings.workerMaxAttempts).toBe(2);
    });

    it("parses comma-separated allow-lists, tolerating spaces", () => {
        const settings = readSlackSettings({
            SLACK_ALLOWED_CHANNEL_IDS: " C1, C2 ,,",
            SLACK_ALLOW_DIRECT_MESSAGES: "FALSE",
        });
        expect([...settings.access.allowedChannelIds]).toEqual(["C1", "C2"]);
        expect(settings.access.allowDirectMessages).toBe(false);
    });

    it("rejects a nonsensical attempt count", () => {
        expect(() => readSlackSettings({ SLACK_WORKER_MAX_ATTEMPTS: "0" })).toThrow("SLACK_WORKER_MAX_ATTEMPTS");
    });
});

describe("isConversationAllowed", () => {
    const policy = (env: Record<string, string>) => readSlackSettings(env).access;

    it("restricts channels to the allow-list, but not DMs", () => {
        const p = policy({ SLACK_ALLOWED_CHANNEL_IDS: "C1" });
        expect(isConversationAllowed(p, { teamId: "T1", channelId: "C1", isDirectMessage: false })).toBe(true);
        expect(isConversationAllowed(p, { teamId: "T1", channelId: "C2", isDirectMessage: false })).toBe(false);
        expect(isConversationAllowed(p, { teamId: "T1", channelId: "D9", isDirectMessage: true })).toBe(true);
    });

    it("applies the workspace allow-list to everything, DMs included", () => {
        const p = policy({ SLACK_ALLOWED_TEAM_IDS: "T1" });
        expect(isConversationAllowed(p, { teamId: "T2", channelId: "D9", isDirectMessage: true })).toBe(false);
    });

    it("can switch DMs off", () => {
        const p = policy({ SLACK_ALLOW_DIRECT_MESSAGES: "false" });
        expect(isConversationAllowed(p, { teamId: "T1", channelId: "D9", isDirectMessage: true })).toBe(false);
    });
});
