import { GroundingVerdict, VerificationAgent } from "../../../../src/services/knowledge/agents/verification.agent";

describe("VerificationAgent", () => {
    describe("screen — before the answer is written", () => {
        let structured: any;
        let agent: VerificationAgent;

        const chunks = [{ content: "The scheduler triggers cons.sh every Sunday.", location: "s3://b/12.md" }];

        beforeEach(() => {
            structured = {
                invoke: jest.fn().mockResolvedValue({ verdict: "sufficient", missing: "", alternativeQuestions: [] }),
            };
            agent = new VerificationAgent(structured);
        });

        it("passes documents that are about the right subject", async () => {
            const result = await agent.screen({ question: "when does it run?", chunks });

            expect(result.verdict).toBe(GroundingVerdict.SUFFICIENT);
        });

        it("stops on a near-miss and offers searchable rephrasings", async () => {
            structured.invoke.mockResolvedValue({
                verdict: "wrong_subject",
                missing: "These documents are about the Llama API, not AWS Lambda.",
                alternativeQuestions: ["Which AWS services does the platform use?", "How is compute provisioned?"],
            });

            const result = await agent.screen({ question: "how do we use Lambda?", chunks });

            expect(result.verdict).toBe(GroundingVerdict.WRONG_SUBJECT);
            expect(result.alternativeQuestions).toHaveLength(2);
        });

        it("caps the rephrasings offered", async () => {
            structured.invoke.mockResolvedValue({
                verdict: "ambiguous",
                missing: "two readings",
                alternativeQuestions: ["a", "b", "c", "d", "e", "f"],
            });

            const result = await agent.screen({ question: "q", chunks });

            expect(result.alternativeQuestions).toEqual(["a", "b", "c", "d"]);
        });

        it("reports nothing retrieved without spending a call on it", async () => {
            const result = await agent.screen({ question: "q", chunks: [] });

            expect(structured.invoke).not.toHaveBeenCalled();
            expect(result.verdict).toBe(GroundingVerdict.WRONG_SUBJECT);
        });

        it("lets the answer through when the screen itself fails, since the audit still runs", async () => {
            structured.invoke.mockRejectedValue(new Error("model unavailable"));

            const result = await agent.screen({ question: "q", chunks });

            expect(result.verdict).toBe(GroundingVerdict.SUFFICIENT);
        });
    });
});
