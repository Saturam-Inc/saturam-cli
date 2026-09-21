import { QuizAgent } from "../../../../src/services/knowledge/agents/quiz.agent";
import { ChatTurn, QuestionIntent } from "../../../../src/services/knowledge/chat-session.model";

const turn = (index: number, answer: string): ChatTurn => ({
    index,
    question: `question ${index}`,
    answer,
    answerGist: `gist ${index}`,
    intent: QuestionIntent.PROJECT_KNOWLEDGE,
    retrievedChunkIds: [],
    createdAt: "2026-01-01T00:00:00Z",
});

describe("QuizAgent", () => {
    let structured: any;
    let llm: any;
    let agent: QuizAgent;

    const posed = {
        question: "Quick check — what actually triggers the weekly DAG runs?",
        modelAnswer: "A separate scheduler daemon, not Airflow's own scheduler.",
        keyPoints: ["the daemon", "not Airflow's scheduler"],
    };

    beforeEach(() => {
        structured = { invoke: jest.fn().mockResolvedValue(posed) };
        llm = { prompt: jest.fn().mockResolvedValue("You got the daemon part. What you missed: ...") };
        agent = new QuizAgent(structured, llm);
    });

    describe("pose", () => {
        it("writes one question from the recent explanations", async () => {
            const result = await agent.pose({ turns: [turn(0, "The daemon triggers cons.sh on Sunday.")] });

            expect(result).toEqual(posed);
        });

        it("draws on the last four explanations only, so the check is fair", async () => {
            const turns = [0, 1, 2, 3, 4, 5].map((i) => turn(i, `answer ${i}`));

            await agent.pose({ turns });

            const [{ messages }] = structured.invoke.mock.calls[0];
            const material = String(messages[1].content);
            expect(material).toContain("answer 5");
            expect(material).toContain("answer 2");
            expect(material).not.toContain("answer 1");
        });

        it("refuses when nothing has been explained yet", async () => {
            await expect(agent.pose({ turns: [] })).rejects.toThrow("nothing to check");
            expect(structured.invoke).not.toHaveBeenCalled();
        });

        it("ignores turns whose answer is empty", async () => {
            await expect(agent.pose({ turns: [turn(0, "   ")] })).rejects.toThrow("nothing to check");
        });

        it("refuses a blank question rather than posing nothing", async () => {
            structured.invoke.mockResolvedValue({ question: "  ", modelAnswer: "", keyPoints: [] });

            await expect(agent.pose({ turns: [turn(0, "an answer")] })).rejects.toThrow("Could not put a check");
        });
    });

    describe("assess", () => {
        it("returns the mentor's feedback", async () => {
            const feedback = await agent.assess({ quiz: posed, learnerAnswer: "the daemon" });

            expect(feedback).toBe("You got the daemon part. What you missed: ...");
        });

        it("hands the model answer and key points to the grader", async () => {
            await agent.assess({ quiz: posed, learnerAnswer: "the daemon" });

            const [messages] = llm.prompt.mock.calls[0];
            const user = String(messages[1].content);
            expect(user).toContain("not Airflow's own scheduler");
            expect(user).toContain("the daemon");
        });

        it("falls back to the model answer when grading fails, so a check never ends the conversation", async () => {
            llm.prompt.mockRejectedValue(new Error("model unavailable"));

            const feedback = await agent.assess({ quiz: posed, learnerAnswer: "no idea" });

            expect(feedback).toContain("A separate scheduler daemon");
            expect(feedback).toContain("the daemon; not Airflow's scheduler");
        });
    });
});
