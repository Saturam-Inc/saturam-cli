import { SessionRef, sessionTimestamp } from "../services/knowledge/session-identity";

/**
 * How Slack conversations map onto the conversation store.
 *
 * Owner = the Slack user within their workspace. Their history follows them across channels,
 * threads and DMs, and carry-over lets a brand-new thread pick up what they were last asking.
 *
 * Session = a thread. Every answer is posted as a threaded reply, so the thread is the natural
 * unit of "this conversation", and starting a new thread is how a user starts over — the Slack
 * equivalent of `--new-session`, with no command to remember.
 */

export function slackOwnerId(teamId: string, userId: string): string {
    return `slack#${teamId}#${userId}`;
}

/**
 * Derived from the thread, so every message in it resolves to the same session with nothing
 * stored to look it up. Keeps the session-id contract: starts with the sortable timestamp (so
 * "most recent session" stays one descending query) and contains no "#".
 *
 * @param threadTs Slack's thread timestamp, "<unix seconds>.<micros>" — unique within a channel.
 */
export function slackSessionId(channelId: string, threadTs: string): string {
    const match = /^(\d+)\.(\d+)$/.exec(threadTs);
    if (!match) throw new Error(`Not a Slack message timestamp: "${threadTs}"`);
    const [, seconds, micros] = match;
    const channel = channelId.replace(/[^A-Za-z0-9]/g, "");
    return `${sessionTimestamp(new Date(Number(seconds) * 1000))}-${channel}-${micros}`;
}

export function slackSessionRef(params: {
    teamId: string;
    userId: string;
    channelId: string;
    threadTs: string;
}): SessionRef {
    return {
        ownerId: slackOwnerId(params.teamId, params.userId),
        sessionId: slackSessionId(params.channelId, params.threadTs),
    };
}
