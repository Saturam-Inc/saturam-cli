import { KnowledgeBaseChatService } from "../../../src/services/knowledge/knowledge-base-chat.service";
import { BedrockKnowledgeBaseService } from "../../../src/integrations/aws/services/bedrock-knowledge-base.service";
import { LlmService } from "../../../src/services/llm-service";

describe("KnowledgeBaseChatService", () => {
    let service: KnowledgeBaseChatService;
    let mockKnowledgeBase: jest.Mocked<BedrockKnowledgeBaseService>;
    let mockLlmService: jest.Mocked<LlmService>;

    beforeEach(() => {
        mockKnowledgeBase = { retrieve: jest.fn() } as any;
        mockLlmService = { prompt: jest.fn() } as any;
        service = new KnowledgeBaseChatService(mockKnowledgeBase, mockLlmService);
    });

    describe("search", () => {
        it("retrieves without a project filter when none is given", async () => {
            mockKnowledgeBase.retrieve.mockResolvedValue([]);
            await service.search("question");
            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("question");
        });

        it("retrieves without a project filter when project is undefined", async () => {
            mockKnowledgeBase.retrieve.mockResolvedValue([]);
            await service.search("question", { project: undefined });
            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("question");
        });

        it("scopes retrieval to the given project", async () => {
            mockKnowledgeBase.retrieve.mockResolvedValue([]);
            await service.search("question", { project: "saturam" });
            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("question", { project: "saturam" });
        });
    });

    describe("ask", () => {
        it("retrieves context then prompts the LLM with it, returning both the answer and chunks", async () => {
            const chunks = [{ content: "auth uses OAuth2", location: "s3://bucket/auth.md" }];
            mockKnowledgeBase.retrieve.mockResolvedValue(chunks);
            mockLlmService.prompt.mockResolvedValue("The auth flow uses OAuth2.");

            const result = await service.ask("what is the auth flow?");

            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("what is the auth flow?");
            expect(mockLlmService.prompt).toHaveBeenCalledTimes(1);
            const [messages] = mockLlmService.prompt.mock.calls[0];
            expect(messages).toHaveLength(2);
            expect(String(messages[1].content)).toContain("auth uses OAuth2");
            expect(result).toEqual({ answer: "The auth flow uses OAuth2.", chunks });
        });

        it("scopes both retrieval and the prompt to the given project", async () => {
            mockKnowledgeBase.retrieve.mockResolvedValue([]);
            mockLlmService.prompt.mockResolvedValue("answer");

            await service.ask("question", { project: "saturam-core" });

            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("question", { project: "saturam-core" });
            const [messages] = mockLlmService.prompt.mock.calls[0];
            expect(String(messages[0].content)).toContain('selected project "saturam-core"');
            expect(String(messages[1].content)).toContain("Selected project: saturam-core");
        });
    });
});
