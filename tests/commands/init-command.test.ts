import { InitCommand } from "../../src/commands/init-command";
import { AIProvider, CloudProvider, ConfigService } from "../../src/services/config-service";
import { LLMModel } from "../../src/constants/llm-models";
import { select, input, password, confirm } from "@inquirer/prompts";

jest.mock("@inquirer/prompts", () => ({
    select: jest.fn(),
    input: jest.fn(),
    password: jest.fn(),
    confirm: jest.fn(),
    checkbox: jest.fn(),
}));

describe("InitCommand Platform Config Flow", () => {
    let command: InitCommand;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            loadPersonalConfig: jest.fn().mockResolvedValue({}),
            savePersonalConfig: jest.fn().mockResolvedValue(undefined),
            getPersonalConfigPath: jest.fn().mockReturnValue("/mock/personal/config.json"),
        } as any;

        command = new InitCommand(mockConfig, {} as any);
    });

    it("should configure Atlassian credentials from top-level menu", async () => {
        // New UX: single select → "atlassian" (no nested Onboarding submenu)
        (select as jest.Mock).mockResolvedValueOnce("atlassian");
        (input as jest.Mock).mockResolvedValueOnce("test@example.com");
        (password as jest.Mock).mockResolvedValueOnce("secret_api_token");

        await command.execute({});

        expect(select).toHaveBeenCalledTimes(1);
        expect(input).toHaveBeenCalled();
        expect(password).toHaveBeenCalled();
        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            atlassianEmail: "test@example.com",
            atlassianToken: "secret_api_token",
        });
    });

    it("should configure Google credentials from top-level menu", async () => {
        // New UX: single select → "google" (no nested Onboarding submenu)
        (select as jest.Mock).mockResolvedValueOnce("google");
        (password as jest.Mock).mockResolvedValueOnce("ya29.google_token");

        await command.execute({});

        expect(select).toHaveBeenCalledTimes(1);
        expect(password).toHaveBeenCalled();
        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            googleAccessToken: "ya29.google_token",
        });
    });

    it("should configure AWS cloud (profile auth, no S3/KB) from top-level menu", async () => {
        // Menu selects: top-level "cloud" -> cloud provider "aws" -> auth method "profile"
        (select as jest.Mock)
            .mockResolvedValueOnce("cloud")
            .mockResolvedValueOnce(CloudProvider.AWS)
            .mockResolvedValueOnce("profile");
        // AWS profile name, then AWS region
        (input as jest.Mock).mockResolvedValueOnce("").mockResolvedValueOnce("us-west-2");
        // Skip S3 and Bedrock Knowledge Base configuration
        (confirm as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

        await command.execute({});

        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            cloud: {
                [CloudProvider.AWS]: {
                    enabled: true,
                    awsAuthMethod: "profile",
                    awsProfile: undefined,
                    awsRegion: "us-west-2",
                    awsAccessKeyId: undefined,
                    awsSecretAccessKey: undefined,
                    awsSessionToken: undefined,
                    s3: undefined,
                    bedrockKnowledgeBase: undefined,
                },
            },
            defaultCloudProvider: CloudProvider.AWS,
        });
    });

    it("should configure Azure OpenAI from the AI providers menu", async () => {
        // Existing config so init offers "Add/update an AI provider" rather than full setup.
        mockConfig.loadPersonalConfig.mockResolvedValue({
            providers: { [AIProvider.ANTHROPIC]: { enabled: true, apiKey: "sk-ant-existing" } },
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

        // top-level "ai_providers" -> action "add" -> provider "azure-openai"
        (select as jest.Mock)
            .mockResolvedValueOnce("ai_providers")
            .mockResolvedValueOnce("add")
            .mockResolvedValueOnce(AIProvider.AZURE_OPENAI);
        (password as jest.Mock).mockResolvedValueOnce("azure-secret-key");
        // endpoint, deployment name, api version
        (input as jest.Mock)
            .mockResolvedValueOnce("https://my-res.openai.azure.com/")
            .mockResolvedValueOnce("gpt-4o-prod")
            .mockResolvedValueOnce("2024-10-21");
        // "Set as the default provider?" -> yes
        (confirm as jest.Mock).mockResolvedValueOnce(true);

        await command.execute({});

        const saved = mockConfig.savePersonalConfig.mock.calls.at(-1)![0];
        expect(saved.providers![AIProvider.AZURE_OPENAI]).toEqual({
            enabled: true,
            apiKey: "azure-secret-key",
            // trailing slash normalized away
            azureEndpoint: "https://my-res.openai.azure.com",
            azureDeploymentName: "gpt-4o-prod",
            azureApiVersion: "2024-10-21",
        });
        // No model picker runs for Azure — the deployment is the model.
        expect(saved.defaultProvider).toBe(AIProvider.AZURE_OPENAI);
        expect(saved.defaultModel).toBe(LLMModel.AZURE_OPENAI_CUSTOM);

        fetchSpy.mockRestore();
    });
});
