import { parseEventsApiBody, parseInteractionPayload, slackTextToPlain } from "../../src/slack/slack-inbound";
import { FEEDBACK_ACTIONS, FOLLOW_UP_ACTION_PREFIX } from "../../src/slack/slack-messages";

const callback = (event: Record<string, unknown>) => ({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    authorizations: [{ user_id: "UBOT" }],
    event,
});

describe("parseEventsApiBody", () => {
    it("answers Slack's URL verification challenge", () => {
        expect(parseEventsApiBody({ type: "url_verification", challenge: "abc" })).toEqual({
            type: "url_verification",
            challenge: "abc",
        });
    });

    it("turns a channel mention into a question in the mention's thread, without the mention", () => {
        const inbound = parseEventsApiBody(
            callback({
                type: "app_mention",
                user: "U1",
                text: "<@UBOT> how does the scheduler work?",
                channel: "C1",
                ts: "100.1",
            }),
        );
        expect(inbound).toEqual({
            type: "question",
            dedupeKey: "event:Ev1",
            teamId: "T1",
            channelId: "C1",
            userId: "U1",
            threadTs: "100.1",
            isDirectMessage: false,
            text: "how does the scheduler work?",
            source: "mention",
        });
    });

    it("keeps a reply in an existing thread in that thread", () => {
        const inbound = parseEventsApiBody(
            callback({
                type: "app_mention",
                user: "U1",
                text: "<@UBOT> and then?",
                channel: "C1",
                ts: "105.1",
                thread_ts: "100.1",
            }),
        );
        expect(inbound).toMatchObject({ type: "question", threadTs: "100.1" });
    });

    it("turns a direct message into a question", () => {
        const inbound = parseEventsApiBody(
            callback({ type: "message", channel_type: "im", user: "U1", text: "hello", channel: "D1", ts: "100.1" }),
        );
        expect(inbound).toMatchObject({
            type: "question",
            source: "direct_message",
            isDirectMessage: true,
            text: "hello",
        });
    });

    it.each([
        [
            "the bot's own message",
            { type: "message", channel_type: "im", user: "UBOT", text: "x", channel: "D1", ts: "1.1" },
        ],
        [
            "another bot",
            { type: "message", channel_type: "im", bot_id: "B1", user: "U2", text: "x", channel: "D1", ts: "1.1" },
        ],
        [
            "an edit",
            { type: "message", channel_type: "im", subtype: "message_changed", user: "U1", channel: "D1", ts: "1.1" },
        ],
        [
            "a channel message without a mention",
            { type: "message", channel_type: "channel", user: "U1", text: "x", channel: "C1", ts: "1.1" },
        ],
    ])("ignores %s", (_label, event) => {
        expect(parseEventsApiBody(callback(event)).type).toBe("ignored");
    });

    it("ignores bodies that are not event callbacks", () => {
        expect(parseEventsApiBody({ type: "app_rate_limited" }).type).toBe("ignored");
        expect(parseEventsApiBody(null).type).toBe("ignored");
    });
});

describe("parseInteractionPayload", () => {
    const payload = (action: Record<string, unknown>) => ({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "C1" },
        message: { ts: "200.1", thread_ts: "100.1" },
        actions: [{ action_ts: "300.1", ...action }],
    });

    it("turns a follow-up click into a question in the answer's thread", () => {
        const inbound = parseInteractionPayload(
            payload({ action_id: `${FOLLOW_UP_ACTION_PREFIX}0`, value: "What triggers it?" }),
        );
        expect(inbound).toEqual({
            type: "question",
            teamId: "T1",
            channelId: "C1",
            userId: "U1",
            threadTs: "100.1",
            isDirectMessage: false,
            dedupeKey: "action:300.1:U1",
            text: "What triggers it?",
            source: "follow_up",
        });
    });

    it("turns a feedback click into feedback on the clicked message", () => {
        const inbound = parseInteractionPayload(
            payload({ action_id: FEEDBACK_ACTIONS.down, value: JSON.stringify({ o: "slack#T1#U9", s: "sess" }) }),
        );
        expect(inbound).toMatchObject({
            type: "feedback",
            rating: "down",
            messageTs: "200.1",
            ownerId: "slack#T1#U9",
            sessionId: "sess",
        });
    });

    it("ignores a feedback value it cannot read, and unknown actions", () => {
        expect(parseInteractionPayload(payload({ action_id: FEEDBACK_ACTIONS.up, value: "{oops" })).type).toBe(
            "ignored",
        );
        expect(parseInteractionPayload(payload({ action_id: "something_else", value: "x" })).type).toBe("ignored");
        expect(parseInteractionPayload({ type: "view_submission" }).type).toBe("ignored");
    });
});

describe("slackTextToPlain", () => {
    it("decodes Slack's markup into what the person typed", () => {
        expect(
            slackTextToPlain(
                "<@UBOT> ask <@U2|sam> about <#C1|infra>: see <https://x.io/a?b=1&amp;c=2|the doc> &lt;now&gt;",
                "UBOT",
            ),
        ).toBe("ask @sam about #infra: see the doc (https://x.io/a?b=1&c=2) <now>");
    });

    it("strips a leading mention when the bot's id is unknown", () => {
        expect(slackTextToPlain("<@UBOT> hi")).toBe("hi");
    });
});
