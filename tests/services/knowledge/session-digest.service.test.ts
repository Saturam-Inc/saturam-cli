import { ChatSession, VERBATIM_TURN_WINDOW } from "../../../src/services/knowledge/chat-session.model";
import { SessionDigestService } from "../../../src/services/knowledge/session-digest.service";

function session(turnCount: number, coversUpToIndex?: number): ChatSession {
    return {
        sessionId: "s1",
        turns: Array.from({ length: turnCount }, (_, i) => ({
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

    it("keeps the previous digest when regeneration fails", async () => {
        structured.invoke.mockRejectedValueOnce(new Error("provider down"));

        const result = await service.refresh(session(VERBATIM_TURN_WINDOW + 5, 0));

        expect(result?.summary).toBe("old");
    });
});
