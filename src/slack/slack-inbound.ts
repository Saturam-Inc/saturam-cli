import { z } from "zod";
import { FEEDBACK_ACTIONS, FOLLOW_UP_ACTION_PREFIX, FeedbackButtonValueSchema } from "./slack-messages";

/**
 * Everything Slack can send us, reduced to what the bot does about it.
 *
 * Pure functions over the two payload families Slack delivers — Events API callbacks and
 * interactivity payloads — shared by the HTTP ingress (Lambda) and the Socket Mode runner (local),
 * which receive the same shapes by different transports.
 */

export type QuestionSource = "mention" | "direct_message" | "follow_up";

interface Conversation {
    teamId: string;
    channelId: string;
    userId: string;
    /** Root of the thread any reply goes in. */
    threadTs: string;
    isDirectMessage: boolean;
}

export type SlackInbound =
    | { type: "url_verification"; challenge: string }
    | (Conversation & {
          type: "question";
          /** Identity of this delivery, for dropping Slack's retries of it. */
          dedupeKey: string;
          text: string;
          source: QuestionSource;
      })
    | (Conversation & {
          type: "feedback";
          dedupeKey: string;
          messageTs: string;
          ownerId: string;
          sessionId: string;
          rating: "up" | "down";
      })
    | { type: "ignored"; reason: string };

const EventSchema = z
    .object({
        type: z.string(),
        subtype: z.string().optional(),
        user: z.string().optional(),
        bot_id: z.string().optional(),
        text: z.string().optional(),
        channel: z.string().optional(),
        channel_type: z.string().optional(),
        ts: z.string().optional(),
        thread_ts: z.string().optional(),
    })
    .passthrough();

const EventCallbackSchema = z
    .object({
        type: z.literal("event_callback"),
        team_id: z.string(),
        event_id: z.string(),
        event: EventSchema,
        authorizations: z.array(z.object({ user_id: z.string().optional() }).passthrough()).optional(),
    })
    .passthrough();

const BlockActionsSchema = z
    .object({
        type: z.literal("block_actions"),
        team: z.object({ id: z.string() }).passthrough(),
        user: z.object({ id: z.string() }).passthrough(),
        channel: z.object({ id: z.string() }).passthrough().optional(),
        message: z.object({ ts: z.string(), thread_ts: z.string().optional() }).passthrough().optional(),
        actions: z
            .array(
                z.object({ action_id: z.string(), value: z.string().optional(), action_ts: z.string() }).passthrough(),
            )
            .min(1),
    })
    .passthrough();

/**
 * Slack message markup to the plain text a person typed. Mentions and links arrive encoded
 * ("<@U123>", "<https://x|label>", "&amp;"), and the agent should read what the user wrote, not
 * Slack's wire format.
 */
export function slackTextToPlain(text: string, botUserId?: string): string {
    return (
        text
            // The bot's own mention is how the question was addressed, not part of it.
            .replace(botUserId ? new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g") : /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>/, "")
            .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
            .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, name?: string) => `@${name ?? id}`)
            .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
            .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
            .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .trim()
    );
}

/** Direct-message channel ids start with "D". */
function isDirectMessageChannel(channelId: string): boolean {
    return channelId.startsWith("D");
}

/**
 * An Events API request body. Answers `@bot` mentions in channels and any message in a DM;
 * everything else — edits, joins, other bots, the bot's own posts — is ignored, which is also
 * what stops the bot from ever replying to itself.
 */
export function parseEventsApiBody(body: unknown): SlackInbound {
    const record = body as Record<string, unknown> | null;
    if (record?.type === "url_verification" && typeof record.challenge === "string") {
        return { type: "url_verification", challenge: record.challenge };
    }

    const parsed = EventCallbackSchema.safeParse(body);
    if (!parsed.success) return { type: "ignored", reason: "not an event callback" };

    const { team_id: teamId, event_id: eventId, event, authorizations } = parsed.data;
    const botUserId = authorizations?.[0]?.user_id;

    if (event.bot_id || !event.user || event.user === botUserId) return { type: "ignored", reason: "bot message" };
    if (event.subtype) return { type: "ignored", reason: `message subtype ${event.subtype}` };
    if (!event.channel || !event.ts) return { type: "ignored", reason: "no channel or timestamp" };

    const isMention = event.type === "app_mention";
    const isDirectMessage = event.type === "message" && event.channel_type === "im";
    if (!isMention && !isDirectMessage) return { type: "ignored", reason: `unhandled event ${event.type}` };

    return {
        type: "question",
        dedupeKey: `event:${eventId}`,
        teamId,
        channelId: event.channel,
        userId: event.user,
        threadTs: event.thread_ts ?? event.ts,
        isDirectMessage: isDirectMessage || isDirectMessageChannel(event.channel),
        text: slackTextToPlain(event.text ?? "", botUserId),
        source: isMention ? "mention" : "direct_message",
    };
}

/**
 * An interactivity payload — a click on one of the buttons the bot attached to an answer.
 */
export function parseInteractionPayload(payload: unknown): SlackInbound {
    const parsed = BlockActionsSchema.safeParse(payload);
    if (!parsed.success) return { type: "ignored", reason: "not a block action" };

    const { team, user, channel, message, actions } = parsed.data;
    const action = actions[0];
    if (!channel || !message) return { type: "ignored", reason: "action outside a message" };

    const conversation: Conversation = {
        teamId: team.id,
        channelId: channel.id,
        userId: user.id,
        threadTs: message.thread_ts ?? message.ts,
        isDirectMessage: isDirectMessageChannel(channel.id),
    };
    const dedupeKey = `action:${action.action_ts}:${user.id}`;

    if (action.action_id.startsWith(FOLLOW_UP_ACTION_PREFIX) && action.value) {
        return { type: "question", ...conversation, dedupeKey, text: action.value.trim(), source: "follow_up" };
    }

    const rating =
        action.action_id === FEEDBACK_ACTIONS.up
            ? "up"
            : action.action_id === FEEDBACK_ACTIONS.down
              ? "down"
              : undefined;
    if (rating && action.value) {
        const value = FeedbackButtonValueSchema.safeParse(safeJson(action.value));
        if (!value.success) return { type: "ignored", reason: "malformed feedback value" };
        return {
            type: "feedback",
            ...conversation,
            dedupeKey,
            messageTs: message.ts,
            ownerId: value.data.o,
            sessionId: value.data.s,
            rating,
        };
    }

    return { type: "ignored", reason: `unhandled action ${action.action_id}` };
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
