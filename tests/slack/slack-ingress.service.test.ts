import { createHmac } from "crypto";
import { SlackIngressService } from "../../src/slack/slack-ingress.service";
import { FOLLOW_UP_ACTION_PREFIX } from "../../src/slack/slack-messages";
import { readSlackSettings } from "../../src/slack/slack-settings";

const SECRET = "signing-secret";

function signed(body: string, contentType = "application/json", extraHeaders: Record<string, string> = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return {
        body,
        headers: {
            "content-type": contentType,
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
            ...extraHeaders,
        },
    };
}

const mention = (text = "<@UBOT> how does the scheduler work?", eventId = "Ev1", channel = "C1") =>
    JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: eventId,
        authorizations: [{ user_id: "UBOT" }],
        event: { type: "app_mention", user: "U1", text, channel, ts: "100.000001" },
    });

describe("SlackIngressService", () => {
    let env: Record<string, string | undefined>;
    let settings: any;
    let gateway: any;
    let state: any;
    let queue: any;
    let ingress: SlackIngressService;

    beforeEach(() => {
        env = {};
        settings = {
            get: jest.fn(() => readSlackSettings(env)),
            getCredentials: jest.fn().mockResolvedValue({ botToken: "xoxb", signingSecret: SECRET }),
        };
        gateway = {
            postInThread: jest.fn().mockResolvedValue("200.000001"),
            update: jest.fn().mockResolvedValue(undefined),
            whisper: jest.fn().mockResolvedValue(undefined),
        };
        const claimed = new Set<string>();
        state = {
            claimDelivery: jest.fn(async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true))),
            releaseDelivery: jest.fn(async (key: string) => void claimed.delete(key)),
        };
        queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
        ingress = new SlackIngressService(settings, gateway, state, { get: () => queue } as any);
    });

    it("rejects a request without a valid signature", async () => {
        const response = await ingress.handleHttp({ body: mention(), headers: { "content-type": "application/json" } });
        expect(response.statusCode).toBe(401);
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("refuses to run with no signing secret rather than skipping verification", async () => {
        settings.getCredentials.mockResolvedValue({ botToken: "xoxb", signingSecret: "" });
        expect((await ingress.handleHttp(signed(mention()))).statusCode).toBe(500);
    });

    it("answers Slack's URL verification challenge", async () => {
        const response = await ingress.handleHttp(
            signed(JSON.stringify({ type: "url_verification", challenge: "c-1" })),
        );
        expect(response).toMatchObject({ statusCode: 200, body: JSON.stringify({ challenge: "c-1" }) });
    });

    it("posts a placeholder in the thread and queues the question for the worker", async () => {
        const response = await ingress.handleHttp(signed(mention()));

        expect(response.statusCode).toBe(200);
        expect(gateway.postInThread).toHaveBeenCalledWith(
            "C1",
            "100.000001",
            expect.objectContaining({ text: "Thinking…" }),
        );
        expect(queue.enqueue).toHaveBeenCalledWith({
            kind: "question",
            id: "event:Ev1",
            teamId: "T1",
            channelId: "C1",
            userId: "U1",
            threadTs: "100.000001",
            question: "how does the scheduler work?",
            source: "mention",
            placeholderTs: "200.000001",
        });
    });

    it("answers a re-delivered event only once", async () => {
        await ingress.handleHttp(signed(mention()));
        const retry = await ingress.handleHttp(signed(mention(), "application/json", { "x-slack-retry-num": "1" }));

        expect(retry.statusCode).toBe(200);
        expect(queue.enqueue).toHaveBeenCalledTimes(1);
        expect(gateway.postInThread).toHaveBeenCalledTimes(1);
    });

    it("releases the delivery and asks Slack to retry when the placeholder cannot be posted", async () => {
        gateway.postInThread.mockRejectedValueOnce(new Error("slack down"));

        expect((await ingress.handleHttp(signed(mention()))).statusCode).toBe(500);
        expect(state.releaseDelivery).toHaveBeenCalledWith("event:Ev1");

        expect((await ingress.handleHttp(signed(mention()))).statusCode).toBe(200);
        expect(queue.enqueue).toHaveBeenCalledTimes(1);
    });

    it("turns the placeholder into an apology when the question cannot be queued", async () => {
        queue.enqueue.mockRejectedValue(new Error("sqs down"));

        expect((await ingress.handleHttp(signed(mention()))).statusCode).toBe(200);
        expect(gateway.update).toHaveBeenCalledWith(
            "C1",
            "200.000001",
            expect.objectContaining({ text: "Sorry — I couldn't answer that just now." }),
        );
    });

    it("tells the user privately when the channel is not on the allow-list, and does not answer", async () => {
        env.SLACK_ALLOWED_CHANNEL_IDS = "C-OTHER";

        await ingress.handleHttp(signed(mention()));

        expect(gateway.whisper).toHaveBeenCalledWith("C1", "U1", expect.stringContaining("not enabled"), "100.000001");
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("replies with a usage hint to a bare mention", async () => {
        await ingress.handleHttp(signed(mention("<@UBOT>")));

        expect(gateway.postInThread).toHaveBeenCalledWith(
            "C1",
            "100.000001",
            expect.objectContaining({ text: expect.stringContaining("Ask me anything") }),
        );
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("turns away a question over the length limit", async () => {
        await ingress.handleHttp(signed(mention(`<@UBOT> ${"x".repeat(4001)}`)));

        expect(gateway.whisper).toHaveBeenCalledWith("C1", "U1", expect.stringContaining("too long"), "100.000001");
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("queues a clicked follow-up from a form-encoded interaction payload", async () => {
        const payload = {
            type: "block_actions",
            team: { id: "T1" },
            user: { id: "U1" },
            channel: { id: "C1" },
            message: { ts: "200.000001", thread_ts: "100.000001" },
            actions: [{ action_id: `${FOLLOW_UP_ACTION_PREFIX}0`, value: "What triggers it?", action_ts: "300.1" }],
        };
        const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;

        expect((await ingress.handleHttp(signed(body, "application/x-www-form-urlencoded"))).statusCode).toBe(200);
        expect(queue.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "question",
                question: "What triggers it?",
                source: "follow_up",
                threadTs: "100.000001",
            }),
        );
    });

    it("acknowledges events it does not handle without doing anything", async () => {
        const body = JSON.stringify({
            type: "event_callback",
            team_id: "T1",
            event_id: "Ev9",
            event: { type: "message", subtype: "message_changed", channel: "D1", ts: "1.1" },
        });
        expect((await ingress.handleHttp(signed(body))).statusCode).toBe(200);
        expect(state.claimDelivery).not.toHaveBeenCalled();
        expect(gateway.postInThread).not.toHaveBeenCalled();
    });
});
