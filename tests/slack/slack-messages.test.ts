import { AnswerResult } from "../../src/services/knowledge/answer-flow.service";
import {
    FEEDBACK_ACTIONS,
    FOLLOW_UP_ACTION_PREFIX,
    answerMessage,
    failureMessage,
    placeholderMessage,
    sourceLinks,
} from "../../src/slack/slack-messages";

const conversation = { ownerId: "slack#T1#U1", sessionId: "20260923T100000Z-C1-000001" };
const typed = { question: "how does it work?", source: "mention" as const, userId: "U1" };
const clicked = { question: "What triggers it?", source: "follow_up" as const, userId: "U1" };

function result(overrides: Partial<AnswerResult> = {}): AnswerResult {
    return {
        answer: "The **scheduler** reads the jobs table. [1]",
        chunks: [
            {
                content: "a",
                location: "s3://bucket/a.md",
                metadata: { url: "https://wiki.example.com/a", title: "Scheduler" },
            },
            { content: "b", location: "s3://bucket/b.md" },
            { content: "c", location: "s3://bucket/c.md", metadata: { url: "https://wiki.example.com/a" } },
        ],
        followUps: [{ question: "What triggers it?", rationale: "" }],
        project: { slug: "orion", displayName: "Orion", aliases: [], sources: [] },
        ...overrides,
    };
}

const texts = (blocks: any[]) => JSON.stringify(blocks);

describe("answerMessage", () => {
    it("renders the answer as mrkdwn with citations stripped", () => {
        const message = answerMessage(result(), typed, conversation);
        expect(texts(message.blocks)).toContain("The *scheduler* reads the jobs table.");
        expect(texts(message.blocks)).not.toContain("[1]");
        expect(message.text).toBe("The **scheduler** reads the jobs table.");
    });

    it("escapes the fallback text, so nothing in an answer reads as a mention there either", () => {
        const message = answerMessage(result({ answer: "ping <!channel> & <@U024BE7LH>" }), typed, conversation);
        expect(message.text).toBe("ping &lt;!channel&gt; &amp; &lt;@U024BE7LH&gt;");
    });

    it("names the project the evidence came from", () => {
        expect(texts(answerMessage(result(), typed, conversation).blocks)).toContain("Orion");
    });

    it("lists each follow-up in full as a row whose Ask button carries the question", () => {
        const question = "Walk me through what the scheduler does when a job it depends on has not finished";
        const rows: any[] = answerMessage(
            result({ followUps: [{ question, rationale: "" }] }),
            typed,
            conversation,
        ).blocks.filter((b: any) => String(b.block_id ?? "").startsWith("follow_ups:"));

        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe("section");
        expect(rows[0].text.text).toBe(question);
        expect(rows[0].accessory).toEqual(
            expect.objectContaining({ type: "button", action_id: `${FOLLOW_UP_ACTION_PREFIX}0`, value: question }),
        );
    });

    it("shows at most three follow-ups", () => {
        const followUps = Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i}?`, rationale: "" }));
        const rows = answerMessage(result({ followUps }), typed, conversation).blocks.filter((b: any) =>
            String(b.block_id ?? "").startsWith("follow_ups:"),
        );
        expect(rows).toHaveLength(3);
    });

    it("attaches feedback buttons that identify the conversation", () => {
        const feedback: any = answerMessage(result(), typed, conversation).blocks.find(
            (b: any) => b.block_id === "feedback",
        );
        expect(feedback.elements.map((e: any) => e.action_id)).toEqual([FEEDBACK_ACTIONS.up, FEEDBACK_ACTIONS.down]);
        expect(JSON.parse(feedback.elements[0].value)).toEqual({ o: conversation.ownerId, s: conversation.sessionId });
    });

    it("omits the follow-up section when there are none", () => {
        const blocks = answerMessage(result({ followUps: [] }), typed, conversation).blocks;
        expect(blocks.find((b: any) => String(b.block_id ?? "").startsWith("follow_ups:"))).toBeUndefined();
        expect(texts(blocks)).not.toContain("You could ask next");
    });

    it("echoes a clicked follow-up, which nobody typed into the thread", () => {
        expect(texts(answerMessage(result(), clicked, conversation).blocks)).toContain("asked: *What triggers it?*");
        expect(texts(answerMessage(result(), typed, conversation).blocks)).not.toContain("asked:");
    });

    it("stays within Slack's 50-block limit for a very long answer", () => {
        const long = Array.from({ length: 1000 }, (_, i) => `Paragraph ${i} ${"word ".repeat(40)}`).join("\n\n");
        const followUps = Array.from({ length: 3 }, (_, i) => ({ question: `Question ${i}?`, rationale: "" }));
        const message = answerMessage(result({ answer: long, followUps }), typed, conversation);
        expect(message.blocks.length).toBeLessThanOrEqual(50);
        expect(texts(message.blocks)).toContain("cut short");
        for (const block of message.blocks as any[]) {
            if (block.type === "section") expect(block.text.text.length).toBeLessThanOrEqual(3000);
        }
    });
});

describe("sourceLinks", () => {
    it("prefers the original document URL, deduplicates, and drops bare s3:// locations", () => {
        expect(sourceLinks(result().chunks)).toEqual([{ url: "https://wiki.example.com/a", title: "Scheduler" }]);
    });

    it("drops a URL that would close Slack's link early and start a token of its own", () => {
        const chunks = [
            { content: "a", location: "s3://bucket/a.md", metadata: { url: "https://a.example/x> <!channel" } },
            { content: "b", location: "s3://bucket/b.md", metadata: { url: "https://a.example/x|<!here" } },
            { content: "c", location: "s3://bucket/c.md", metadata: { url: "https://a.example/ok", title: "Fine" } },
        ];

        expect(sourceLinks(chunks)).toEqual([{ url: "https://a.example/ok", title: "Fine" }]);
        const blocks = answerMessage(result({ chunks }), typed, conversation).blocks;
        expect(texts(blocks)).not.toContain("<!channel");
        expect(texts(blocks)).not.toContain("<!here");
    });
});

describe("placeholderMessage and failureMessage", () => {
    it("shows progress, echoing only a clicked question", () => {
        expect(texts(placeholderMessage(typed).blocks)).not.toContain("asked:");
        expect(texts(placeholderMessage(clicked).blocks)).toContain("asked:");
    });

    it("gives a reference id but never the underlying error", () => {
        const message = failureMessage(typed, "event:Ev1");
        expect(texts(message.blocks)).toContain("event:Ev1");
    });
});
