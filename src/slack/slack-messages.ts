import type { KnownBlock } from "@slack/types";
import { z } from "zod";
import type { RetrievedChunk } from "../integrations/aws/services/bedrock-knowledge-base.service";
import type { AnswerResult } from "../services/knowledge/answer-flow.service";
import { stripInlineCitations } from "../utils/citations.util";
import type { QuestionSource } from "./slack-inbound";
import { escapeMrkdwn, markdownToMrkdwn, splitMrkdwn } from "./slack-mrkdwn";

/**
 * Every message the bot posts, as Block Kit. Pure: given what to say, returns what to send, so
 * the layout is testable without Slack and the ingress and worker cannot drift apart on it.
 */

export interface SlackMessage {
    /** Plain fallback for notifications, screen readers and clients that cannot render blocks. */
    text: string;
    blocks: KnownBlock[];
}

export const FOLLOW_UP_ACTION_PREFIX = "follow_up:";
export const FEEDBACK_ACTIONS = { up: "feedback:up", down: "feedback:down" } as const;

/** What a feedback button carries back: the conversation the rated answer belongs to. */
export const FeedbackButtonValueSchema = z.object({ o: z.string().min(1), s: z.string().min(1) });

/** Slack's limits, from the Block Kit reference. */
const MAX_BLOCKS = 50;
const BUTTON_TEXT_LIMIT = 75;
const BUTTON_VALUE_LIMIT = 2000;
const FALLBACK_TEXT_LIMIT = 300;
const MAX_SOURCES = 6;

/** Room kept below MAX_BLOCKS for the header, sources, follow-ups and feedback blocks. */
const MAX_ANSWER_SECTIONS = MAX_BLOCKS - 8;

function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function context(text: string): KnownBlock {
    return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function section(text: string): KnownBlock {
    return { type: "section", text: { type: "mrkdwn", text } };
}

export interface AskedQuestion {
    question: string;
    source: QuestionSource;
    userId: string;
}

/**
 * A clicked follow-up was never typed, so nothing in the thread would show what is being
 * answered. Every message that stands in that question's place leads with it.
 */
function echoedQuestion(asked: AskedQuestion): KnownBlock[] {
    if (asked.source !== "follow_up") return [];
    return [context(`<@${asked.userId}> asked: *${escapeMrkdwn(truncate(asked.question, 500))}*`)];
}

/** Shown the moment a question is accepted, and replaced in place by the answer. */
export function placeholderMessage(asked: AskedQuestion): SlackMessage {
    return {
        text: "Thinking…",
        blocks: [...echoedQuestion(asked), section(":hourglass_flowing_sand: _Searching the knowledge base…_")],
    };
}

/**
 * The document URLs behind an answer. Prefers the original URL the ingestion pipeline stored in
 * metadata (Confluence, Jira, Drive) over `location`, which is the S3 object Bedrock ingested and
 * not something a person can open; an s3:// location alone is dropped for the same reason.
 */
export function sourceLinks(chunks: RetrievedChunk[]): Array<{ url: string; title: string }> {
    const seen = new Map<string, string>();
    for (const chunk of chunks) {
        const metadataUrl = chunk.metadata?.url;
        const url = (typeof metadataUrl === "string" && metadataUrl) || chunk.location;
        if (!url || !/^https?:\/\//.test(url) || seen.has(url)) continue;
        const title = chunk.metadata?.title;
        seen.set(url, typeof title === "string" && title.trim() ? title.trim() : shortUrl(url));
    }
    return [...seen].slice(0, MAX_SOURCES).map(([url, title]) => ({ url, title }));
}

function shortUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return truncate(`${parsed.hostname}${parsed.pathname}`.replace(/\/$/, ""), 60);
    } catch {
        return truncate(url, 60);
    }
}

export function answerMessage(
    result: AnswerResult,
    asked: AskedQuestion,
    conversation: { ownerId: string; sessionId: string },
): SlackMessage {
    const mrkdwn = markdownToMrkdwn(stripInlineCitations(result.answer).trim());
    const sections = splitMrkdwn(mrkdwn);
    const shown = sections.slice(0, MAX_ANSWER_SECTIONS);
    if (shown.length < sections.length)
        shown.push("_…the answer was too long for one Slack message and has been cut short._");

    const blocks: KnownBlock[] = [...echoedQuestion(asked)];
    if (result.project) blocks.push(context(`:file_folder: *${escapeMrkdwn(result.project.displayName)}*`));
    blocks.push(...shown.map(section));

    const sources = sourceLinks(result.chunks);
    if (sources.length > 0) {
        const links = sources.map((s) => `<${s.url}|${escapeMrkdwn(s.title).replace(/\|/g, "¦")}>`).join("  ·  ");
        blocks.push(context(`*Sources:* ${links}`));
    }

    const followUps = result.followUps.slice(0, 4);
    if (followUps.length > 0) {
        blocks.push({ type: "divider" });
        blocks.push(context("*You could ask next:*"));
        blocks.push({
            type: "actions",
            block_id: "follow_ups",
            elements: followUps.map((followUp, index) => ({
                type: "button",
                action_id: `${FOLLOW_UP_ACTION_PREFIX}${index}`,
                text: { type: "plain_text", text: truncate(followUp.question, BUTTON_TEXT_LIMIT), emoji: true },
                value: truncate(followUp.question, BUTTON_VALUE_LIMIT),
            })),
        });
    }

    const feedbackValue = JSON.stringify({ o: conversation.ownerId, s: conversation.sessionId });
    blocks.push({
        type: "actions",
        block_id: "feedback",
        elements: [
            {
                type: "button",
                action_id: FEEDBACK_ACTIONS.up,
                text: { type: "plain_text", text: ":thumbsup: Helpful", emoji: true },
                value: feedbackValue,
            },
            {
                type: "button",
                action_id: FEEDBACK_ACTIONS.down,
                text: { type: "plain_text", text: ":thumbsdown: Not helpful", emoji: true },
                value: feedbackValue,
            },
        ],
    });

    return { text: truncate(stripInlineCitations(result.answer).trim(), FALLBACK_TEXT_LIMIT), blocks };
}

/**
 * Posted in place of an answer that could not be produced. Carries a reference id so a report
 * can be matched to the logs, but never the underlying error: that can name tables, ARNs or
 * model ids that have no business in a channel.
 */
export function failureMessage(asked: AskedQuestion, referenceId: string): SlackMessage {
    const text =
        ":warning: Sorry — I couldn't answer that just now. Please try again in a minute; " +
        `if it keeps happening, share this reference with the team: \`${escapeMrkdwn(referenceId)}\``;
    return { text: "Sorry — I couldn't answer that just now.", blocks: [...echoedQuestion(asked), section(text)] };
}

export function retryingMessage(asked: AskedQuestion): SlackMessage {
    return {
        text: "Still working…",
        blocks: [
            ...echoedQuestion(asked),
            section(":hourglass_flowing_sand: _That took longer than expected — trying again…_"),
        ],
    };
}

/** A short message with no controls — hints and notices. */
export function noticeMessage(text: string): SlackMessage {
    return { text, blocks: [section(text)] };
}

export const USAGE_HINT =
    "Ask me anything about our projects — how something works, where it lives, why it was built that way. " +
    "Mention me in a channel or message me directly. Each thread is its own conversation, so start a new " +
    "thread to change the subject.";

export const QUESTION_TOO_LONG = "That question is too long for me — could you shorten it and ask again?";

export const NOT_ENABLED_HERE =
    "I'm not enabled in this channel. Message me directly, or ask an admin to add this channel to my allow-list.";

export const FEEDBACK_THANKS = "Thanks — your feedback helps improve these answers.";
