import { BedrockKnowledgeBaseService } from "../../../../src/integrations/aws/services/bedrock-knowledge-base.service";
import { ConfigService } from "../../../../src/services/config-service";

const mockSend = jest.fn();
const mockBedrockClient = jest.fn().mockImplementation(() => ({ send: mockSend }));

jest.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
    BedrockAgentRuntimeClient: mockBedrockClient,
    RetrieveCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe("BedrockKnowledgeBaseService", () => {
    let service: BedrockKnowledgeBaseService;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            getAWSCloudConfig: jest.fn().mockResolvedValue({ enabled: true, awsRegion: "us-east-1" }),
            getBedrockKnowledgeBaseConfig: jest
                .fn()
                .mockResolvedValue({ knowledgeBaseId: "KB123", region: "ap-south-1" }),
        } as any;
        service = new BedrockKnowledgeBaseService(mockConfig);
    });

    it("retrieve maps results and passes the query to RetrieveCommand", async () => {
        mockSend.mockResolvedValueOnce({
            retrievalResults: [
                {
                    content: { text: "chunk one" },
                    score: 0.9,
                    location: { s3Location: { uri: "s3://bucket/key.md" } },
                    metadata: { project: "saturam", category: "google-docs" },
                },
            ],
        });

        const results = await service.retrieve("what is the auth flow?", { numberOfResults: 3 });

        expect(results).toEqual([
            {
                content: "chunk one",
                score: 0.9,
                location: "s3://bucket/key.md",
                metadata: { project: "saturam", category: "google-docs" },
            },
        ]);
        expect(mockBedrockClient).toHaveBeenCalledWith(expect.objectContaining({ region: "ap-south-1" }));
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    knowledgeBaseId: "KB123",
                    retrievalQuery: { text: "what is the auth flow?" },
                    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3 } },
                }),
            }),
        );
    });

    it("retrieve throws a descriptive error when the SDK call fails", async () => {
        mockSend.mockRejectedValueOnce(new Error("AccessDeniedException"));

        await expect(service.retrieve("query")).rejects.toThrow(
            "Failed to retrieve from Bedrock Knowledge Base KB123: AccessDeniedException",
        );
    });

    it("applies an exact project metadata filter when a project is provided", async () => {
        mockSend.mockResolvedValueOnce({ retrievalResults: [] });

        await service.retrieve("give me the overview", { project: "saturam-core" });

        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    retrievalQuery: { text: "give me the overview" },
                    retrievalConfiguration: {
                        vectorSearchConfiguration: {
                            numberOfResults: undefined,
                            filter: { equals: { key: "project", value: "saturam-core" } },
                        },
                    },
                }),
            }),
        );
    });

    it("rebuilds the client when the knowledge base's region changes between calls", async () => {
        mockSend.mockResolvedValue({ retrievalResults: [] });

        (mockConfig.getBedrockKnowledgeBaseConfig as jest.Mock).mockResolvedValueOnce({
            knowledgeBaseId: "KB123",
            region: "ap-south-1",
        });
        await service.retrieve("first question");
        expect(mockBedrockClient).toHaveBeenCalledTimes(1);
        expect(mockBedrockClient).toHaveBeenLastCalledWith(expect.objectContaining({ region: "ap-south-1" }));

        // Same region again — client is reused, not rebuilt.
        (mockConfig.getBedrockKnowledgeBaseConfig as jest.Mock).mockResolvedValueOnce({
            knowledgeBaseId: "KB123",
            region: "ap-south-1",
        });
        await service.retrieve("second question");
        expect(mockBedrockClient).toHaveBeenCalledTimes(1);

        // Different region — the cached client must not be silently reused.
        (mockConfig.getBedrockKnowledgeBaseConfig as jest.Mock).mockResolvedValueOnce({
            knowledgeBaseId: "KB456",
            region: "us-west-2",
        });
        await service.retrieve("third question");
        expect(mockBedrockClient).toHaveBeenCalledTimes(2);
        expect(mockBedrockClient).toHaveBeenLastCalledWith(expect.objectContaining({ region: "us-west-2" }));
    });
});
