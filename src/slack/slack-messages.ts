import type { KnownBlock } from "@slack/types";
import { z } from "zod";
import type { RetrievedChunk } from "../integrations/aws/services/bedrock-knowledge-base.service";
import type { AnswerResult } from "../services/knowledge/answer-flow.service";
import { stripInlineCitations } from "../utils/citations.util";
import type { QuestionSource } from "./slack-inbound";
import { SECTION_TEXT_LIMIT, escapeMrkdwn, markdownToMrkdwn, splitMrkdwn } from "./slack-mrkdwn";

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
const BUTTON_VALUE_LIMIT = 2000;
const FALLBACK_TEXT_LIMIT = 300;
const MAX_SOURCES = 6;
const MAX_FOLLOW_UPS_SHOWN = 3;

/**
 * Room kept below MAX_BLOCKS: the echoed question, project, sources, divider, follow-up heading
 * and feedback blocks, the "cut short" notice, and one block per follow-up.
 */
const MAX_ANSWER_SECTIONS = MAX_BLOCKS - (7 + MAX_FOLLOW_UPS_SHOWN);

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

/**
 * One row per follow-up: the question as the row's text, with an "Ask" button beside it.
 *
 * They used to be buttons in one actions block, with the question as the label. Slack sizes a
 * button to its label but clips the label at the width the row allows, and a row holding three or
 * four of them allows very little, so a question showed as its first few words. There is no way to
 * ask for a wider button. Section text wraps to the full message width, so the question goes
 * there, and the button only needs to say what clicking it does.
 */
function followUpRow(followUp: { question: string }, index: number): KnownBlock {
    return {
        type: "section",
        block_id: `follow_ups:${index}`,
        text: { type: "mrkdwn", text: escapeMrkdwn(truncate(followUp.question, SECTION_TEXT_LIMIT)) },
        accessory: {
            type: "button",
            action_id: `${FOLLOW_UP_ACTION_PREFIX}${index}`,
            text: { type: "plain_text", text: "Ask", emoji: true },
            value: truncate(followUp.question, BUTTON_VALUE_LIMIT),
        },
    };
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

    const followUps = result.followUps.slice(0, MAX_FOLLOW_UPS_SHOWN);
    if (followUps.length > 0) {
        blocks.push({ type: "divider" });
        blocks.push(context("*You could ask next:*"));
        blocks.push(...followUps.map(followUpRow));
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
