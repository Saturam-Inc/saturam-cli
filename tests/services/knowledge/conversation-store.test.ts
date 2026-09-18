import { ChatTurn, MAX_RETAINED_TURNS, QuestionIntent } from "../../../src/services/knowledge/chat-session.model";
import { InMemoryConversationStore } from "../../../src/services/knowledge/conversation-store";

function turn(index: number): ChatTurn {
    return {
        index,
        question: `q${index}`,
        answer: `a${index}`,
        answerGist: `g${index}`,
        intent: QuestionIntent.PROJECT_KNOWLEDGE,
        retrievedChunkIds: [],
        createdAt: new Date().toISOString(),
    };
}

describe("InMemoryConversationStore", () => {
    let store: InMemoryConversationStore;

    beforeEach(() => {
        store = new InMemoryConversationStore();
    });

    it("returns an empty session for an unknown id rather than throwing", async () => {
        const session = await store.load("unknown");

        expect(session).toEqual({ sessionId: "unknown", turns: [] });
    });

    it("appends turns in order", async () => {
        await store.appendTurn("s1", turn(0));
        await store.appendTurn("s1", turn(1));

        const session = await store.load("s1");
        expect(session.turns.map((t) => t.index)).toEqual([0, 1]);
    });

    it("keeps only the most recent turns, since older ones survive through the digest", async () => {
        for (let i = 0; i < MAX_RETAINED_TURNS + 5; i += 1) {
            await store.appendTurn("s1", turn(i));
        }

        const session = await store.load("s1");
        expect(session.turns).toHaveLength(MAX_RETAINED_TURNS);
        expect(session.turns[0].index).toBe(5);
    });

    it("keeps the digest and active project independent of one another", async () => {
        await store.saveActiveProject("s1", "smile");
        await store.saveDigest("s1", {
            summary: "covered refunds",
            projectsDiscussed: ["smile"],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 2,
        });

        const session = await store.load("s1");
        expect(session.activeProject).toBe("smile");
        expect(session.digest?.summary).toBe("covered refunds");
    });

    it("isolates sessions from each other", async () => {
        await store.appendTurn("s1", turn(0));
        await store.appendTurn("s2", turn(0));
        await store.saveActiveProject("s1", "smile");

        expect((await store.load("s2")).activeProject).toBeUndefined();
    });
});
