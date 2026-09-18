import { ChatTurn, MAX_RETAINED_TURNS, QuestionIntent } from "../../../src/services/knowledge/chat-session.model";
import { InMemoryConversationStore } from "../../../src/services/knowledge/conversation-store";
import { SessionRef } from "../../../src/services/knowledge/session-identity";

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

const OWNER = "owner#vinoth#ubuntu";
const ref = (sessionId: string): SessionRef => ({ ownerId: OWNER, sessionId });

describe("InMemoryConversationStore", () => {
    let store: InMemoryConversationStore;

    beforeEach(() => {
        store = new InMemoryConversationStore();
    });

    it("returns an empty session for an unknown id rather than throwing", async () => {
        const session = await store.load(ref("unknown"));

        expect(session).toEqual({ sessionId: "unknown", turns: [] });
    });

    it("appends turns in order", async () => {
        await store.appendTurn(ref("s1"), turn(0));
        await store.appendTurn(ref("s1"), turn(1));

        const session = await store.load(ref("s1"));
        expect(session.turns.map((t) => t.index)).toEqual([0, 1]);
    });

    it("keeps only the most recent turns, since older ones survive through the digest", async () => {
        for (let i = 0; i < MAX_RETAINED_TURNS + 5; i += 1) {
            await store.appendTurn(ref("s1"), turn(i));
        }

        const session = await store.load(ref("s1"));
        expect(session.turns).toHaveLength(MAX_RETAINED_TURNS);
        expect(session.turns[0].index).toBe(5);
    });

    it("keeps the digest and active project independent of one another", async () => {
        await store.saveActiveProject(ref("s1"), "smile");
        await store.saveDigest(ref("s1"), {
            summary: "covered refunds",
            projectsDiscussed: ["smile"],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 2,
        });

        const session = await store.load(ref("s1"));
        expect(session.activeProject).toBe("smile");
        expect(session.digest?.summary).toBe("covered refunds");
    });

    it("isolates sessions from each other", async () => {
        await store.appendTurn(ref("s1"), turn(0));
        await store.appendTurn(ref("s2"), turn(0));
        await store.saveActiveProject(ref("s1"), "smile");

        expect((await store.load(ref("s2"))).activeProject).toBeUndefined();
    });
});

describe("isSessionStale", () => {
    const { isSessionStale, SESSION_IDLE_HOURS } = require("../../../src/services/knowledge/chat-session.model");

    function sessionEndingAt(iso: string) {
        return { sessionId: "s1", turns: [{ ...turn(0), createdAt: iso }] };
    }

    it("treats an empty session as fresh, so a first question is never rotated away", () => {
        expect(isSessionStale({ sessionId: "s1", turns: [] })).toBe(false);
    });

    it("continues a conversation that is still active", () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        expect(isSessionStale(sessionEndingAt(tenMinutesAgo))).toBe(false);
    });

    it("starts a new conversation once the last one has gone cold", () => {
        // The bug this guards: every run appended to one partition forever, so a recap mixed
        // questions from different days and the sticky project scoped new questions to old topics.
        const stale = new Date(Date.now() - (SESSION_IDLE_HOURS + 1) * 60 * 60 * 1000).toISOString();
        expect(isSessionStale(sessionEndingAt(stale))).toBe(true);
    });

    it("does not rotate on an unparseable timestamp, which would discard real history", () => {
        expect(isSessionStale(sessionEndingAt("not-a-date"))).toBe(false);
    });
});

describe("owner-scoped sessions", () => {
    let store: InMemoryConversationStore;

    beforeEach(() => {
        store = new InMemoryConversationStore();
    });

    it("lists an owner's sessions newest first, so a new terminal joins the live one", async () => {
        await store.appendTurn(ref("older"), turn(0));
        await store.appendTurn(ref("newer"), turn(0));

        expect(await store.findRecentSessionIds(OWNER, 5)).toEqual(["newer", "older"]);
    });

    it("keeps one owner's sessions invisible to another", async () => {
        await store.appendTurn({ ownerId: "owner#other#user", sessionId: "theirs" }, turn(0));

        expect(await store.findRecentSessionIds(OWNER, 5)).toEqual([]);
    });

    it("returns nothing for an owner with no history rather than throwing", async () => {
        expect(await store.findRecentSessionIds("owner#nobody#nobody", 5)).toEqual([]);
    });

    it("keeps two sessions of the same owner separate", async () => {
        await store.appendTurn(ref("a"), turn(0));
        await store.appendTurn(ref("b"), turn(0));
        await store.saveActiveProject(ref("a"), "mrf");

        expect((await store.load(ref("b"))).activeProject).toBeUndefined();
        expect((await store.load(ref("a"))).activeProject).toBe("mrf");
    });
});
