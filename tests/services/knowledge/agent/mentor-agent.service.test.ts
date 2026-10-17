import { AIMessage } from "@langchain/core/messages";
import {
    MAX_PLAN_TOOL_ROUNDS,
    MAX_TOOL_ROUNDS,
    MentorAgentService,
} from "../../../../src/services/knowledge/agent/mentor-agent.service";
import { KnowledgeToolFactory } from "../../../../src/services/knowledge/agent/knowledge-tools";

const project = { slug: "orion", displayName: "Orion", aliases: [], sources: [] };

const chunk = (content: string, slug = "orion") => ({
    content,
    location: `s3://docs/${content.slice(0, 8)}.md`,
    score: 0.5,
    metadata: { project: slug, title: "doc" },
});

/** An AIMessage carrying tool calls, as a tool-calling provider returns one. */
const withToolCall = (name: string, args: Record<string, unknown>, id = "c1") =>
    Object.assign(new AIMessage({ content: "" }), { tool_calls: [{ id, name, args }] });

describe("MentorAgentService", () => {
    let knowledgeBase: any;
    let registry: any;
    let reader: any;
    let codeIndex: any;
    let llm: any;
    let bound: any;
    let agent: MentorAgentService;

    const buildAgent = (model: any) => {
        llm = { getModel: jest.fn().mockResolvedValue(model), prompt: jest.fn().mockResolvedValue("forced answer") };
        return new MentorAgentService(
            llm,
            new KnowledgeToolFactory(knowledgeBase, registry, reader, codeIndex),
            registry,
        );
    };

    beforeEach(() => {
        knowledgeBase = { retrieve: jest.fn().mockResolvedValue([chunk("the scheduler reads a jobs table")]) };
        registry = {
            getBySlug: jest.fn().mockResolvedValue(project),
            load: jest.fn().mockResolvedValue({ projects: [project] }),
        };
        reader = {
            documentIdOf: jest.fn().mockResolvedValue(undefined),
            read: jest.fn().mockResolvedValue({
                key: "orion/bitbucket/core/jobs/nightly.py.md",
                path: "jobs/nightly.py",
                content: "1 | def run():",
                identifiers: ["jobs/nightly.py"],
            }),
        };
        codeIndex = { repositories: jest.fn().mockResolvedValue([]), find: jest.fn(), listDirectory: jest.fn() };
        bound = { invoke: jest.fn() };
        agent = buildAgent({ bindTools: jest.fn().mockReturnValue(bound) });
    });

    const ask = (question = "how does the scheduler work?") => agent.answer({ question, recentTurns: [], history: [] });

    it("searches, then answers from what came back", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "It reads a jobs table." }));

        const result = await ask();

        // No project, no kind: the broadest search there is.
        expect(knowledgeBase.retrieve).toHaveBeenCalledWith("scheduler", { numberOfResults: 12 });
        expect(result.answer).toBe("It reads a jobs table.");
        expect(result.chunks).toHaveLength(1);
        expect(result.projectSlug).toBe("orion");
    });

    it("hands the flow every name it saw by reading, so the guard does not take it back", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "nightly job", kind: "code" }))
            .mockResolvedValueOnce(withToolCall("read_document", { document: "acme/core:jobs/nightly.py" }, "c2"))
            .mockResolvedValueOnce(new AIMessage({ content: "It is in `jobs/nightly.py`." }));

        const result = await ask("where is the nightly job?");

        expect(knowledgeBase.retrieve).toHaveBeenCalledWith(
            "nightly job",
            expect.objectContaining({ category: "bitbucket" }),
        );
        expect(reader.read).toHaveBeenCalledWith("acme/core:jobs/nightly.py", expect.anything());
        expect(String(bound.invoke.mock.calls[2][0].at(-1).content)).toBe("1 | def run():");
        expect(result.knownIdentifiers).toContain("jobs/nightly.py");
    });

    it("lets the agent search again when the first query misses", async () => {
        knowledgeBase.retrieve
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([chunk("jobs are triggered by a cron entry")]);

        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "wrong wording" }))
            .mockResolvedValueOnce(
                withToolCall("search_documentation", { query: "job triggering", project: "orion" }, "c2"),
            )
            .mockResolvedValueOnce(new AIMessage({ content: "A cron entry triggers it." }));

        const result = await ask();

        expect(knowledgeBase.retrieve).toHaveBeenCalledTimes(2);
        expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
            "job triggering",
            expect.objectContaining({ project: "orion" }),
        );
        expect(result.answer).toBe("A cron entry triggers it.");
    });

    it("tells the agent a search returned nothing rather than inventing an empty result", async () => {
        knowledgeBase.retrieve.mockResolvedValue([]);
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "billing" }))
            .mockResolvedValueOnce(new AIMessage({ content: "That is not documented." }));

        const result = await ask("how does billing work?");

        const toolReply = String(bound.invoke.mock.calls[1][0].at(-1).content);
        expect(toolReply).toContain("No passages matched");
        expect(result.chunks).toEqual([]);
    });

    it("surfaces a retrieval failure to the agent instead of throwing", async () => {
        knowledgeBase.retrieve.mockRejectedValue(new Error("knowledge base unreachable"));
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "I could not reach the documentation." }));

        await expect(ask()).resolves.toMatchObject({ answer: "I could not reach the documentation." });
        expect(String(bound.invoke.mock.calls[1][0].at(-1).content)).toContain("knowledge base unreachable");
    });

    it("answers a corpus question from list_projects, with no search", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("list_projects", {}))
            .mockResolvedValueOnce(new AIMessage({ content: "I have documentation for Orion." }));

        const result = await ask("what can you tell me about?");

        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
        expect(String(bound.invoke.mock.calls[1][0].at(-1).content)).toContain("Orion [slug: orion");
        expect(result.answer).toBe("I have documentation for Orion.");
    });

    it("recalls earlier turns through its own tool", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("recall_conversation", {}))
            .mockResolvedValueOnce(new AIMessage({ content: "You asked about the scheduler." }));

        await agent.answer({
            question: "what was I asking about?",
            recentTurns: [],
            history: [
                {
                    index: 0,
                    question: "how does the scheduler work?",
                    answer: "long answer",
                    answerGist: "explained the scheduler",
                    retrievedChunkIds: [],
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ],
        });

        expect(String(bound.invoke.mock.calls[1][0].at(-1).content)).toContain("explained the scheduler");
    });

    it("reports an unknown tool back to the agent rather than failing the question", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("make_it_up", {}))
            .mockResolvedValueOnce(new AIMessage({ content: "Recovered." }));

        await expect(ask()).resolves.toMatchObject({ answer: "Recovered." });
        expect(String(bound.invoke.mock.calls[1][0].at(-1).content)).toContain('no tool called "make_it_up"');
    });

    it("stops looping and forces an answer when the agent keeps searching", async () => {
        bound.invoke.mockResolvedValue(withToolCall("search_documentation", { query: "again" }));

        const result = await ask();

        expect(result.answer).toBe("forced answer");
        expect(llm.prompt).toHaveBeenCalled();
        expect(bound.invoke).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    });

    it("widens the round budget once the agent declares it is planning a change, and reports the goal", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("begin_change_plan", { goal: "move the nightly job to 03:00" }))
            .mockResolvedValue(withToolCall("search_documentation", { query: "again" }));

        const result = await ask("how do I move the nightly job to 03:00?");

        // The same message array is handed to every round, so look for the checklist anywhere in it.
        const messages = bound.invoke.mock.calls[1][0] as Array<{ content: unknown }>;
        expect(messages.some((m) => String(m.content).includes("Plan recorded: move the nightly job"))).toBe(true);
        expect(bound.invoke).toHaveBeenCalledTimes(MAX_PLAN_TOOL_ROUNDS);
        expect(result.planGoal).toBe("move the nightly job to 03:00");
    });

    it("widens the round budget once the agent declares a walkthrough, and reports the subject", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("begin_walkthrough", { subject: "how the nightly pipeline runs" }))
            .mockResolvedValue(withToolCall("search_documentation", { query: "again" }));

        const result = await ask("walk me through the nightly pipeline end to end");

        const messages = bound.invoke.mock.calls[1][0] as Array<{ content: unknown }>;
        expect(messages.some((m) => String(m.content).includes("Walkthrough recorded: how the nightly"))).toBe(true);
        expect(bound.invoke).toHaveBeenCalledTimes(MAX_PLAN_TOOL_ROUNDS);
        expect(result.walkthroughSubject).toBe("how the nightly pipeline runs");
    });

    it("sends unsupported names back once, with the tools still attached, before finishing", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "Edit `config/schedule.yaml` to change it." }))
            .mockResolvedValueOnce(new AIMessage({ content: "It is driven by the jobs table." }));

        const result = await ask();

        expect(result.answer).toBe("It is driven by the jobs table.");
        expect(bound.invoke).toHaveBeenCalledTimes(3);
        const third = bound.invoke.mock.calls[2][0] as Array<{ content: unknown }>;
        const request = String(third[third.length - 1].content);
        expect(request).toContain("nothing you retrieved supports this name: `config/schedule.yaml`");
        expect(request).toContain("verify it with a tool");
    });

    it("lets the agent verify a name with a tool during that round", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "It is in `jobs/nightly.py`." }))
            .mockResolvedValueOnce(withToolCall("read_document", { document: "acme/core:jobs/nightly.py" }, "c2"))
            .mockResolvedValueOnce(new AIMessage({ content: "It is in `jobs/nightly.py`, in run()." }));

        const result = await ask();

        expect(reader.read).toHaveBeenCalledTimes(1);
        expect(result.answer).toBe("It is in `jobs/nightly.py`, in run().");
        expect(result.knownIdentifiers).toContain("jobs/nightly.py");
    });

    it("verifies at most once, and finishes without a round when every name is supported", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "See `a/one.py`." }))
            .mockResolvedValueOnce(new AIMessage({ content: "See `b/two.py`." }));
        expect((await ask()).answer).toBe("See `b/two.py`.");
        expect(bound.invoke).toHaveBeenCalledTimes(3);

        bound.invoke.mockReset();
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "It reads a jobs table." }));
        expect((await ask()).answer).toBe("It reads a jobs table.");
        expect(bound.invoke).toHaveBeenCalledTimes(2);
    });

    it("puts the agent's own notes into the forced final prompt", async () => {
        bound.invoke
            .mockResolvedValueOnce(
                withToolCall("note_findings", { established: "the daemon in jobs/daemon.py triggers it" }),
            )
            .mockResolvedValue(withToolCall("search_documentation", { query: "again" }));

        const result = await ask();

        expect(result.answer).toBe("forced answer");
        expect(result.findings).toEqual([{ established: "the daemon in jobs/daemon.py triggers it" }]);
        const forcedMessages = llm.prompt.mock.calls[0][0] as Array<{ content: unknown }>;
        const last = String(forcedMessages[forcedMessages.length - 1].content);
        expect(last).toContain("Your notes so far:");
        expect(last).toContain("- the daemon in jobs/daemon.py triggers it");
    });

    it("leaves the goal unset for a question that was not a change", async () => {
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "scheduler" }))
            .mockResolvedValueOnce(new AIMessage({ content: "It reads a jobs table." }));

        expect((await ask()).planGoal).toBeUndefined();
    });

    it("de-duplicates chunks seen by more than one search", async () => {
        knowledgeBase.retrieve.mockResolvedValue([chunk("same passage")]);
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "a" }))
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "b" }, "c2"))
            .mockResolvedValueOnce(new AIMessage({ content: "done" }));

        expect((await ask()).chunks).toHaveLength(1);
    });

    it("leaves the project unset when the evidence spans two of them", async () => {
        knowledgeBase.retrieve.mockResolvedValue([chunk("orion doc", "orion"), chunk("vega doc", "vega")]);
        bound.invoke
            .mockResolvedValueOnce(withToolCall("search_documentation", { query: "terraform" }))
            .mockResolvedValueOnce(new AIMessage({ content: "Both use it." }));

        expect((await ask()).projectSlug).toBeUndefined();
    });

    it("falls back to one search and one prompt when the provider cannot call tools", async () => {
        agent = buildAgent({ invoke: jest.fn() });
        llm.prompt.mockResolvedValue("Answered without tools.");

        const result = await ask();

        expect(knowledgeBase.retrieve).toHaveBeenCalledTimes(1);
        expect(knowledgeBase.retrieve).toHaveBeenCalledWith("how does the scheduler work?", expect.anything());
        expect(result.answer).toBe("Answered without tools.");
        expect(result.chunks).toHaveLength(1);
    });
});
