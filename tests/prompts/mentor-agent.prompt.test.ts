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

    describe("planning a change", () => {
        it("treats 'show me how to change it' as a plan question, and changes one mechanism only", () => {
            const text = systemTextOf();
            expect(text).toContain('"show me how to change it"');
            expect(text).toContain("do not also give it a schedule of its own");
            expect(text).toContain("A change goes to the mechanism that does the thing today, and only that one.");
            expect(text).toContain("what must run before it and what runs after it");
            expect(text).toContain("stays consistent with what this conversation already established");
        });

        it("tells the agent that tool results are private, so what is asked for must be shown", () => {
            const text = systemTextOf();
            expect(text).toContain("What a tool returns is visible only to you");
            expect(text).toContain('never refer to a tool result as "above"');
        });

        it("has the agent declare the plan first, then locate, trace and only then write", () => {
            const text = systemTextOf();
            expect(text).toContain("call begin_change_plan first");
            expect(text).toContain("find_symbol for where it is defined, find_references for everything that uses it");
            expect(text).toContain("change-impact-map and making-changes guides first, through open_guide");
        });

        it("asks for the one shape a plan needs: numbered, verifiable steps with impact and verification", () => {
            const text = systemTextOf();
            expect(text).toContain("The plan is numbered steps");
            expect(text).toContain("a plan without steps is not a plan");
            expect(text).toContain("open questions in your own voice");
        });

        it("plans something new from the footprint of the nearest existing thing", () => {
            expect(systemTextOf()).toContain(
                "find the nearest existing thing of the same kind and plan from its footprint",
            );
        });

        it("says none of this when the provider cannot call tools", () => {
            expect(systemTextOf({ preGatheredContext: "(nothing retrieved)" })).not.toContain("begin_change_plan");
        });
    });

    describe("explaining how something works", () => {
        it("has the agent declare the walkthrough first, then follow the path hop by hop", () => {
            const text = systemTextOf();
            expect(text).toContain("call begin_walkthrough first");
            expect(text).toContain("follow the path through the code hop by hop, reading each file you will describe");
            expect(text).toContain("Write in the order the data moves");
            expect(text).toContain("show the path as a short text diagram");
        });

        it("keeps a narrow single-function question out of the walkthrough", () => {
            expect(systemTextOf()).toContain("does not need the walkthrough");
        });

        it("says none of this when the provider cannot call tools", () => {
            expect(systemTextOf({ preGatheredContext: "(nothing retrieved)" })).not.toContain("begin_walkthrough");
        });
    });

    describe("finding what it needs", () => {
        it("points at the guides by name, at notes across rounds, and at parallel searches", () => {
            const text = systemTextOf();
            expect(text).toContain("open_guide opens one by name");
            expect(text).toContain("call note_findings after each round of results");
            expect(text).toContain("run the ones that do not depend on each other in the same round");
        });
    });

    describe("code beside documentation", () => {
        it("tells the agent the corpus holds both, and to search them apart when the question is about one", () => {
            const text = systemTextOf();
            expect(text).toContain("written documentation, and source code indexed from the repositories");
            expect(text).toContain("Search them apart when the question is clearly about one");
        });

        it("has the agent read a file before explaining a slice of it, and browse rather than guess a path", () => {
            const text = systemTextOf();
            expect(text).toContain("read the file around it before you explain it");
            expect(text).toContain("browse the repository rather than guessing a path");
        });

        it("settles a disagreement between documentation and code in favour of the code for what happens", () => {
            expect(systemTextOf()).toContain(
                "the documentation describes the intent and the code describes what runs today",
            );
        });

        it("asks for code to be cited by path and symbol, exactly as written", () => {
            expect(systemTextOf()).toContain(
                "Cite code by its path and the function or class name, exactly as written",
            );
        });

        it("says none of this when the provider cannot call tools", () => {
            expect(systemTextOf({ preGatheredContext: "(nothing retrieved)" })).not.toContain("browse the repository");
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
            expect(text).toContain('Stopping at "that is not covered here" is a non-answer');
        });

        it("still forbids inventing a link between a general technology and our systems", () => {
            expect(systemTextOf()).toContain("invent a connection between it and our systems");
        });

        it("treats the difference between general practice and ours as the useful part", () => {
            expect(systemTextOf()).toContain("Where the two differ");
        });

        it("keeps the two kinds of knowledge labelled apart", () => {
            const text = systemTextOf();
            expect(text).toContain("Never present general practice as ours");
        });
    });

    describe("voice", () => {
        it("tells the agent to state facts rather than narrate where it looked", () => {
            const text = systemTextOf();
            expect(text).toContain("not as a librarian reporting on it");
            expect(text).toContain('never "the docs say the weekly trigger runs Sunday at 01:30 UTC"');
        });

        it("names the attribution phrases to delete", () => {
            const text = systemTextOf();
            for (const phrase of ["the docs say", "as documented in", "the documentation shows"]) {
                expect(text).toContain(phrase);
            }
        });

        it("does not ask for a source on every claim, since the interface lists them", () => {
            const text = systemTextOf();
            expect(text).toContain("rather than attaching a citation to every claim");
            // The rule that produced a "Source:" line under every answer must not come back.
            expect(text).not.toMatch(/two-sentence answer names its source/);
        });

        it("keeps provenance for the two cases where it changes what the reader does", () => {
            expect(systemTextOf()).toContain(
                "Provenance is worth a sentence only when it changes what the reader should do",
            );
        });
    });

    describe("messages that are not questions", () => {
        it("answers a bare greeting without searching or returning to the previous turn", () => {
            const text = systemTextOf();
            expect(text).toContain("A bare greeting, thanks or pleasantry");
            expect(text).toContain("No searching, and no returning to anything asked earlier");
        });

        it("continues the previous turn only for a message with no subject of its own", () => {
            expect(systemTextOf()).toContain("a greeting or a new subject never does");
        });
    });

    describe("turns carried from an earlier session", () => {
        const turn = {
            index: 0,
            question: "who owns the scheduler?",
            answer: "I don't have that information.",
            answerGist: "said the owner is not recorded and to ask the team lead",
            retrievedChunkIds: [],
            createdAt: "2026-09-30T00:00:00Z",
        };
        const lastMessageOf = (params: { recentTurns: (typeof turn)[]; carriedTurns?: number }) => {
            const messages = getMentorAgentMessages({ question: "Hi", ...params });
            return String(messages[messages.length - 1].content);
        };

        it("marks them as a previous session's, so a greeting is not read as a continuation", () => {
            const text = lastMessageOf({ recentTurns: [turn], carriedTurns: 1 });
            expect(text).toContain("from a previous session");
            expect(text).toContain("not a subject to return to");
        });

        it("says which ones when the window also holds this session's own turns", () => {
            const text = lastMessageOf({
                recentTurns: [turn, { ...turn, index: 1 }, { ...turn, index: 2 }],
                carriedTurns: 2,
            });
            expect(text).toContain("The first 2 exchanges above are from a previous session");
        });

        it("says nothing when every turn in the window is this session's own", () => {
            expect(lastMessageOf({ recentTurns: [turn], carriedTurns: 0 })).not.toContain("previous session");
            expect(lastMessageOf({ recentTurns: [turn] })).not.toContain("previous session");
        });
    });

    describe("gaps", () => {
        it("has the agent own a gap in its own voice rather than report on the documents", () => {
            const text = systemTextOf();
            expect(text).toContain('"I don\'t have that information"');
            expect(text).toContain('never "the docs don\'t name it"');
        });

        it("names the negative attribution phrases as the same habit", () => {
            const text = systemTextOf();
            expect(text).toContain("isn't documented anywhere");
            expect(text).toContain("the documentation does not mention");
        });

        it("points the reader at a person who would know", () => {
            expect(systemTextOf()).toContain("their manager or team lead");
        });

        it("treats questions about people as ones the documentation rarely answers", () => {
            expect(systemTextOf()).toContain("documentation rarely records people");
        });

        it("still gives the general way to find the thing out", () => {
            expect(systemTextOf()).toContain("the repository's code owners file");
        });

        it("applies the same to the unanswered part of a partial answer", () => {
            expect(systemTextOf()).toContain("say plainly that you do not have the rest, and say who would");
        });

        it("applies the same when the provider cannot call tools", () => {
            const text = systemTextOf({ preGatheredContext: "(nothing retrieved)" });
            expect(text).toContain("say you do not have that information and who they could ask");
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
