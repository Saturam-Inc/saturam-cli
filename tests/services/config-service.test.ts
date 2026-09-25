import {
    ConfigService,
    AIProvider,
    CloudProvider,
    PersonalConfigurationSchema,
} from "../../src/services/config-service";
import { LLMModel } from "../../src/constants/llm-models";
import { WorkingDirectory } from "../../src/utils/working-directory";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

jest.mock("fs", () => {
    const actualFs = jest.requireActual("fs");
    return {
        ...actualFs,
        existsSync: jest.fn(),
    };
});

jest.mock("fs/promises", () => {
    const actualFsPromises = jest.requireActual("fs/promises");
    return {
        ...actualFsPromises,
        readFile: jest.fn(),
    };
});

describe("ConfigService Onboarding Credentials", () => {
    let service: ConfigService;
    let mockDir: WorkingDirectory;
    let originalEnv: NodeJS.ProcessEnv;

    beforeAll(() => {
        originalEnv = { ...process.env };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    beforeEach(() => {
        process.env = { ...originalEnv };
        // Clear Atlassian/Google env vars
        delete process.env.GOOGLE_ACCESS_TOKEN;
        delete process.env.ATLASSIAN_TOKEN;
        delete process.env.ATLASSIAN_EMAIL;
        delete process.env.CONFLUENCE_TOKEN;
        delete process.env.CONFLUENCE_EMAIL;
        delete process.env.JIRA_TOKEN;
        delete process.env.JIRA_EMAIL;

        mockDir = new WorkingDirectory("/mock/cwd", "/mock/cli", "/mock/repo");
        service = new ConfigService(mockDir);

        // Mock loadPersonalConfig to return custom values
        jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
            defaultProvider: AIProvider.GOOGLE,
            defaultModel: undefined as any,
            providers: {},
        });
    });

    describe("getGoogleAccessToken", () => {
        it("should return token from env var if present", async () => {
            process.env.GOOGLE_ACCESS_TOKEN = "env_google_token";
            const token = await service.getGoogleAccessToken();
            expect(token).toBe("env_google_token");
        });

        it("should return token from personal config if env is not present", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                googleAccessToken: "config_google_token",
            } as any);

            const token = await service.getGoogleAccessToken();
            expect(token).toBe("config_google_token");
        });

        it("should throw if token is missing", async () => {
            await expect(service.getGoogleAccessToken()).rejects.toThrow("No Google Access Token found");
        });
    });

    describe("getConfluenceCredentials", () => {
        it("should return credentials from CONFLUENCE_TOKEN env var if present", async () => {
            process.env.CONFLUENCE_TOKEN = "conf_token";
            process.env.CONFLUENCE_EMAIL = "conf_email";
            const creds = await service.getConfluenceCredentials();
            expect(creds).toEqual({
                email: "conf_email",
                token: "conf_token",
            });
        });

        it("should fallback to generic Atlassian credentials if specific env is missing", async () => {
            process.env.ATLASSIAN_TOKEN = "generic_token";
            process.env.ATLASSIAN_EMAIL = "generic_email";
            const creds = await service.getConfluenceCredentials();
            expect(creds).toEqual({
                email: "generic_email",
                token: "generic_token",
            });
        });
    });

    describe("getJiraCredentials", () => {
        it("should return credentials from JIRA_TOKEN env var if present", async () => {
            process.env.JIRA_TOKEN = "jira_token";
            process.env.JIRA_EMAIL = "jira_email";
            const creds = await service.getJiraCredentials();
            expect(creds).toEqual({
                email: "jira_email",
                token: "jira_token",
            });
        });

        it("should fallback to generic Atlassian credentials if specific env is missing", async () => {
            process.env.ATLASSIAN_TOKEN = "generic_token";
            process.env.ATLASSIAN_EMAIL = "generic_email";
            const creds = await service.getJiraCredentials();
            expect(creds).toEqual({
                email: "generic_email",
                token: "generic_token",
            });
        });
    });

    describe("getGenericAtlassianCredentials", () => {
        it("should return credentials from personal config if env vars are missing", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                atlassianToken: "config_token",
                atlassianEmail: "config_email",
            } as any);

            const creds = await service.getGenericAtlassianCredentials();
            expect(creds).toEqual({
                email: "config_email",
                token: "config_token",
            });
        });

        it("should throw if Atlassian credentials are missing", async () => {
            await expect(service.getGenericAtlassianCredentials()).rejects.toThrow("No Atlassian credentials found");
        });
    });

    describe("model ID normalization (PersonalConfigurationSchema)", () => {
        it("leaves a current model ID untouched", () => {
            const parsed = PersonalConfigurationSchema.parse({ defaultModel: LLMModel.GEMINI_3_1_PRO_PREVIEW });
            expect(parsed.defaultModel).toBe(LLMModel.GEMINI_3_1_PRO_PREVIEW);
        });

        it("still strips region prefixes for Bedrock model IDs", () => {
            const parsed = PersonalConfigurationSchema.parse({ defaultModel: "us.anthropic.claude-opus-4-6-v1" });
            expect(parsed.defaultModel).toBe(LLMModel.BEDROCK_CLAUDE_4_6_OPUS);
        });

        it("falls back to undefined instead of throwing when a saved model ID is no longer recognized", () => {
            // A retired/renamed model ID must not break the entire config parse — every
            // ConfigService method that reads personal/project/session config depends on it.
            const parsed = PersonalConfigurationSchema.parse({ defaultModel: "some-retired-model-id" });
            expect(parsed.defaultModel).toBeUndefined();
        });

        it("accepts every currently-valid Gemini model ID", () => {
            for (const model of [
                LLMModel.GEMINI_2_5_PRO,
                LLMModel.GEMINI_2_5_FLASH,
                LLMModel.GEMINI_3_1_PRO_PREVIEW,
                LLMModel.GEMINI_3_5_FLASH,
                LLMModel.GEMINI_3_6_FLASH,
                LLMModel.GEMINI_3_7_FLASH,
            ]) {
                expect(PersonalConfigurationSchema.parse({ defaultModel: model }).defaultModel).toBe(model);
            }
        });
    });

    describe("hasAnyLLMProviderConfigured", () => {
        it("should return false when no providers are configured", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({ providers: {} } as any);
            await expect(service.hasAnyLLMProviderConfigured()).resolves.toBe(false);
        });

        it("should return false when providers is undefined", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({} as any);
            await expect(service.hasAnyLLMProviderConfigured()).resolves.toBe(false);
        });

        it("should return true when at least one provider is configured", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                providers: { [AIProvider.ANTHROPIC]: { enabled: true, apiKey: "sk-test" } },
            } as any);
            await expect(service.hasAnyLLMProviderConfigured()).resolves.toBe(true);
        });
    });

    describe("getS3Config", () => {
        it("should throw if AWS cloud is not configured", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({} as any);
            await expect(service.getS3Config()).rejects.toThrow("AWS cloud is not configured");
        });

        it("should throw if S3 is not configured under AWS cloud", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: { [CloudProvider.AWS]: { enabled: true, awsRegion: "us-east-1" } },
            } as any);
            await expect(service.getS3Config()).rejects.toThrow("S3 is not configured");
        });

        it("should return bucket/prefix/region, falling back to awsRegion when s3.region is unset", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: {
                    [CloudProvider.AWS]: {
                        enabled: true,
                        awsRegion: "eu-west-1",
                        s3: { bucket: "my-bucket", prefix: "docs" },
                    },
                },
            } as any);
            const s3Config = await service.getS3Config();
            expect(s3Config).toEqual({
                bucket: "my-bucket",
                prefix: "docs",
                statePrefix: "docs-state",
                region: "eu-west-1",
            });
        });

        it("should prefer an explicitly configured statePrefix over the derived default", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: {
                    [CloudProvider.AWS]: {
                        enabled: true,
                        awsRegion: "eu-west-1",
                        s3: { bucket: "my-bucket", prefix: "onboarding", statePrefix: "pipeline-state" },
                    },
                },
            } as any);
            const s3Config = await service.getS3Config();
            expect(s3Config.statePrefix).toBe("pipeline-state");
        });

        it("should leave statePrefix unset when there is no content prefix to sit beside", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: {
                    [CloudProvider.AWS]: { enabled: true, awsRegion: "eu-west-1", s3: { bucket: "my-bucket" } },
                },
            } as any);
            const s3Config = await service.getS3Config();
            expect(s3Config.statePrefix).toBeUndefined();
        });

        it("should throw if S3 has no bucket region or AWS region", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: {
                    [CloudProvider.AWS]: {
                        enabled: true,
                        s3: { bucket: "my-bucket", prefix: "docs" },
                    },
                },
            } as any);
            await expect(service.getS3Config()).rejects.toThrow("S3 region is not configured");
        });
    });

    describe("getBedrockKnowledgeBaseConfig", () => {
        it("should throw if Bedrock Knowledge Base is not configured", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: { [CloudProvider.AWS]: { enabled: true } },
            } as any);
            await expect(service.getBedrockKnowledgeBaseConfig()).rejects.toThrow(
                "Bedrock Knowledge Base is not configured",
            );
        });

        it("should return knowledgeBaseId/dataSourceId/region", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: {
                    [CloudProvider.AWS]: {
                        enabled: true,
                        awsRegion: "us-east-1",
                        bedrockKnowledgeBase: { knowledgeBaseId: "KB123", dataSourceId: "DS1" },
                    },
                },
            } as any);
            const kbConfig = await service.getBedrockKnowledgeBaseConfig();
            expect(kbConfig).toEqual({ knowledgeBaseId: "KB123", dataSourceId: "DS1", region: "us-east-1" });
        });

        it("should throw if Knowledge Base has no region or AWS region", async () => {
            jest.spyOn(service, "loadPersonalConfig").mockResolvedValue({
                cloud: {
                    [CloudProvider.AWS]: {
                        enabled: true,
                        bedrockKnowledgeBase: { knowledgeBaseId: "KB123", dataSourceId: "DS1" },
                    },
                },
            } as any);
            await expect(service.getBedrockKnowledgeBaseConfig()).rejects.toThrow(
                "Bedrock Knowledge Base region is not configured",
            );
        });
    });
});
