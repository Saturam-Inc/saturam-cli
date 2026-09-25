import { getKnowledgeBaseChatMessages } from "../../src/prompts/knowledge-base-chat.prompt";

describe("getKnowledgeBaseChatMessages", () => {
    it("includes labeled chunks with their source location in the user message", () => {
        const { system, user } = getKnowledgeBaseChatMessages({
            question: "what is the auth flow?",
            chunks: [
                { content: "Auth uses OAuth2.", score: 0.95, location: "s3://bucket/auth.md" },
                { content: "Tokens expire after 1 hour." },
            ],
        });

        expect(String(system.content)).toContain("ONLY the context provided");
        expect(String(system.content)).toContain('Do not include inline citation markers like "[1]"');
        const userText = String(user.content);
        expect(userText).toContain("Context 1 (source: s3://bucket/auth.md)");
        expect(userText).toContain("Auth uses OAuth2.");
        expect(userText).toContain("Context 2\nTokens expire after 1 hour.");
        expect(userText).toContain("Question: what is the auth flow?");
    });

    it("tells the LLM no context was found when there are no chunks", () => {
        const { user } = getKnowledgeBaseChatMessages({ question: "anything?", chunks: [] });

        expect(String(user.content)).toContain("No relevant context was found");
    });

    it("instructs the LLM to answer only for the selected project", () => {
        const { system, user } = getKnowledgeBaseChatMessages({
            question: "give me an overview",
            chunks: [{ content: "Saturam project details." }],
            project: "saturam",
        });

        expect(String(system.content)).toContain('selected project "saturam"');
        expect(String(system.content)).toContain("ignore any context that appears unrelated");
        expect(String(user.content)).toContain("Selected project: saturam");
    });
});
