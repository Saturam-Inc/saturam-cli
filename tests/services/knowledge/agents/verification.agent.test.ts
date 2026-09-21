import { GroundingVerdict, VerificationAgent } from "../../../../src/services/knowledge/agents/verification.agent";

describe("VerificationAgent", () => {
    describe("audit — after the answer exists", () => {
        let structured: any;
        let agent: VerificationAgent;

        const chunks = [{ content: "The scheduler daemon triggers cons.sh every Sunday.", location: "s3://b/12.md" }];

        beforeEach(() => {
            structured = { invoke: jest.fn().mockResolvedValue({ unsupportedClaims: [] }) };
            agent = new VerificationAgent(structured);
        });

        it("reports the claims the model could not find support for", async () => {
            structured.invoke.mockResolvedValue({ unsupportedClaims: ["retries three times", "runs on Kubernetes"] });

            const result = await agent.audit({ question: "how does it run?", answer: "long answer", chunks });

            expect(result.unsupportedClaims).toEqual(["retries three times", "runs on Kubernetes"]);
        });

        it("caps the list so a wall of warnings does not bury the answer", async () => {
            structured.invoke.mockResolvedValue({ unsupportedClaims: ["a", "b", "c", "d", "e"] });

            const result = await agent.audit({ question: "q", answer: "a", chunks });

            expect(result.unsupportedClaims).toEqual(["a", "b", "c"]);
        });

        it("drops blank entries rather than rendering an empty bullet", async () => {
            structured.invoke.mockResolvedValue({ unsupportedClaims: ["  ", "real claim", ""] });

            const result = await agent.audit({ question: "q", answer: "a", chunks });

            expect(result.unsupportedClaims).toEqual(["real claim"]);
        });

        it("skips the call when there are no documents to check against", async () => {
            const result = await agent.audit({ question: "q", answer: "an answer", chunks: [] });

            expect(structured.invoke).not.toHaveBeenCalled();
            expect(result.unsupportedClaims).toEqual([]);
        });

        it("skips the call when there is no answer to check", async () => {
            const result = await agent.audit({ question: "q", answer: "   ", chunks });

            expect(structured.invoke).not.toHaveBeenCalled();
            expect(result.unsupportedClaims).toEqual([]);
        });

        it("stays silent when the audit itself fails, rather than warning about unchecked claims", async () => {
            structured.invoke.mockRejectedValue(new Error("model unavailable"));

            const result = await agent.audit({ question: "q", answer: "a", chunks });

            expect(result.unsupportedClaims).toEqual([]);
        });

        it("sends the question, the answer and the documents to the judge", async () => {
            await agent.audit({ question: "how does it run?", answer: "the answer", chunks });

            const [{ messages }] = structured.invoke.mock.calls[0];
            const user = String(messages[messages.length - 1].content);
            expect(user).toContain("how does it run?");
            expect(user).toContain("the answer");
            expect(user).toContain("cons.sh every Sunday");
        });
    });

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
