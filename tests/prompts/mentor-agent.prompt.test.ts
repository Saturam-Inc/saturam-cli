import { getMentorAgentMessages } from "../../src/prompts/mentor-agent.prompt";
import { getReviseAnswerMessages } from "../../src/prompts/revise-answer.prompt";

const QUESTION = "how does the scheduler decide what to run?";

const systemTextOf = (params?: { preGatheredContext?: string }) => {
    const [system] = getMentorAgentMessages({ question: QUESTION, recentTurns: [], ...params });
    return String(system.content);
};

/**
 * The answering contract now lives almost entirely in one prompt, so it is asserted here rather
 * than inferred from branch coverage.
 *
 * The general-knowledge rules exist because of a real regression: an absolute "where the
 * documentation is silent, 'it is not written down' is the complete answer" suppressed ordinary
 * engineering answers too. Asked what AWS S3 was, mid-conversation about an indexed project, the
 * agent correctly reported that the corpus did not mention it — and then stopped, without ever
 * saying what S3 is. The rule protecting against invented project facts had swallowed the rule
 * allowing general ones.
 */
describe("mentor agent prompt", () => {
    describe("searching", () => {
        it("tells the agent to search before answering", () => {
            expect(systemTextOf()).toContain("search the documentation");
        });

        it("tells the agent to search again rather than answer around a miss", () => {
            expect(systemTextOf()).toContain("search again with different wording");
        });

        it("drops the search guidance when the provider cannot call tools", () => {
            const text = systemTextOf({ preGatheredContext: "(nothing retrieved)" });
            expect(text).toContain("You cannot run searches yourself");
            expect(text).not.toContain("search again with different wording");
        });
    });

    describe("general knowledge when the corpus is silent", () => {
        it("scopes the never-invent rule to claims about our systems", () => {
            const text = systemTextOf();
            expect(text).toContain("Never invent anything about our systems");
            // The unscoped form is what suppressed general answers; it must not come back.
            expect(text).not.toMatch(/is the complete and correct answer/);
            expect(text).not.toMatch(/Do not substitute general knowledge/);
        });

        it("requires a general explanation instead of only reporting the gap", () => {
            const text = systemTextOf();
            expect(text).toContain("never a reason to withhold a general answer");
            expect(text).toContain('Stopping at "that is not documented here" is a non-answer');
        });

        it("still forbids inventing a link between a general technology and our systems", () => {
            expect(systemTextOf()).toContain("invent a connection between it and our systems");
        });

        it("asks for what the documentation shows about our use of it, including nothing", () => {
            expect(systemTextOf()).toContain("including that it shows nothing");
        });

        it("keeps the two kinds of knowledge labelled apart", () => {
            const text = systemTextOf();
            expect(text).toContain("Never present general practice as ours");
        });
    });

    describe("revision after the identifier check", () => {
        const reviseTextOf = () => {
            const [system] = getReviseAnswerMessages({
                question: QUESTION,
                answer: "You would normally reach for `boto3` to do this.",
                unsupported: ["boto3"],
            });
            return String(system.content);
        };

        it("leaves public names alone, since the search only covers our documentation", () => {
            const text = reviseTextOf();
            expect(text).toContain("leave it exactly as it is");
            expect(text).toContain("a public name's absence from it means nothing");
        });

        it("returns the answer unchanged when nothing on the list is ours", () => {
            expect(reviseTextOf()).toContain(
                "If every identifier on the list is the world's, return the answer unchanged",
            );
        });

        it("still revises identifiers presented as part of our systems", () => {
            const text = reviseTextOf();
            expect(text).toContain("presents as part of our systems");
            expect(text).toContain("the documentation does not name the script that does this");
        });
    });
});
