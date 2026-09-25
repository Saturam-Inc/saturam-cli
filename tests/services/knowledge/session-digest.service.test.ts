import {
    ChatSession,
    MAX_RETAINED_TURNS,
    VERBATIM_TURN_WINDOW,
} from "../../../src/services/knowledge/chat-session.model";
import { SessionDigestService } from "../../../src/services/knowledge/session-digest.service";

function session(turnCount: number, coversUpToIndex?: number): ChatSession {
    return trimmedSession(turnCount, coversUpToIndex, turnCount);
}

/** A session as a store hands it back: `totalTurns` asked, only the last `retained` kept. */
function trimmedSession(totalTurns: number, coversUpToIndex?: number, retained = MAX_RETAINED_TURNS): ChatSession {
    const firstIndex = Math.max(0, totalTurns - retained);
    return {
        sessionId: "s1",
        turns: Array.from({ length: totalTurns - firstIndex }, (_, offset) => firstIndex + offset).map((i) => ({
            index: i,
            question: `q${i}`,
            answer: `a${i}`,
            answerGist: `g${i}`,
            retrievedChunkIds: [],
            createdAt: new Date().toISOString(),
        })),
        digest:
            coversUpToIndex === undefined
                ? undefined
                : { summary: "old", projectsDiscussed: [], jargonDefined: [], questionsAsked: [], coversUpToIndex },
    };
}

describe("SessionDigestService", () => {
    let structured: any;
    let service: SessionDigestService;

    beforeEach(() => {
        structured = {
            invoke: jest.fn().mockResolvedValue({
                summary: "new summary",
                projectsDiscussed: ["smile"],
                jargonDefined: ["ADF"],
                questionsAsked: ["q0"],
            }),
        };
        service = new SessionDigestService(structured);
    });

    it("does not refresh while everything still fits in the verbatim window", () => {
        expect(service.shouldRefresh(session(VERBATIM_TURN_WINDOW))).toBe(false);
    });

    it("refreshes once enough turns have aged out of the verbatim window", () => {
        expect(service.shouldRefresh(session(VERBATIM_TURN_WINDOW + 5))).toBe(true);
    });

    it("does not refresh again until another interval has passed", () => {
        // Five turns already covered — one more aged-out turn is not worth a call.
        expect(service.shouldRefresh(session(VERBATIM_TURN_WINDOW + 6, 5))).toBe(false);
    });

    it("summarizes only the turns not already covered", async () => {
        await service.refresh(session(VERBATIM_TURN_WINDOW + 6, 3));

        const [{ messages }] = structured.invoke.mock.calls[0];
        const transcript = messages[messages.length - 1].content as string;
        expect(transcript).toContain("q3");
        expect(transcript).not.toContain("q2:");
    });

    it("records how far the digest now covers, so the next refresh resumes there", async () => {
        const result = await service.refresh(session(VERBATIM_TURN_WINDOW + 5));

        expect(result?.coversUpToIndex).toBe(5);
        expect(result?.summary).toBe("new summary");
    });

    it("keeps refreshing once the store has trimmed the session to its retained window", () => {
        // 26 turns asked, 20 kept. Counting array entries saw 20 - 3 = 17 aged out against 15
        // covered — never another full interval, so the digest froze for the rest of the session.
        expect(service.shouldRefresh(trimmedSession(26, 15))).toBe(true);
    });

    it("summarizes a trimmed session by turn index, not array position", async () => {
        // Turns 20-39 retained; 30-36 have aged out of the verbatim window since the last refresh.
        const result = await service.refresh(trimmedSession(40, 30));

        const [{ messages }] = structured.invoke.mock.calls[0];
        const transcript = messages[messages.length - 1].content as string;
        expect(transcript).toContain("Q: q30\n");
        expect(transcript).toContain("Q: q36\n");
        expect(transcript).not.toContain("Q: q29\n");
        expect(transcript).not.toContain("Q: q37\n");
        expect(result?.coversUpToIndex).toBe(37);
    });

    it("keeps the previous digest when regeneration fails", async () => {
        structured.invoke.mockRejectedValueOnce(new Error("provider down"));

        const result = await service.refresh(session(VERBATIM_TURN_WINDOW + 5, 0));

        expect(result?.summary).toBe("old");
    });
});
