import { mergePersonalConfig, personalConfigFromEnvironment } from "../../src/services/config-environment";
import { PersonalConfigurationSchema } from "../../src/services/config-service";

describe("personalConfigFromEnvironment", () => {
    it("returns nothing when no SATENG_* variable is set, so the CLI is unaffected", () => {
        expect(personalConfigFromEnvironment({ AWS_REGION: "us-east-1", HOME: "/home/x" })).toBeUndefined();
    });

    it("builds the cloud config a server deployment needs, with no credentials in it", () => {
        const overlay = personalConfigFromEnvironment({
            AWS_REGION: "ap-south-1",
            SATENG_MODEL: "anthropic.claude-sonnet-4-5-20250929-v1:0",
            SATENG_KB_ID: "KB123",
            SATENG_S3_BUCKET: "docs-bucket",
            SATENG_S3_PREFIX: "onboarding",
            SATENG_CONVERSATION_TABLE: "conversations",
            SATENG_CONVERSATION_TTL_DAYS: "30",
        });

        const parsed = PersonalConfigurationSchema.parse(overlay);
        expect(parsed.defaultModel).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
        expect(parsed.cloud?.aws).toMatchObject({
            awsRegion: "ap-south-1",
            bedrockKnowledgeBase: { knowledgeBaseId: "KB123" },
            s3: { bucket: "docs-bucket", prefix: "onboarding" },
            conversationTable: { tableName: "conversations", ttlDays: 30 },
        });
        // The execution role supplies credentials through the default chain.
        expect(parsed.cloud?.aws?.awsAuthMethod).toBeUndefined();
        expect(parsed.cloud?.aws?.awsAccessKeyId).toBeUndefined();
    });

    it("lets the schema reject a malformed value rather than silently dropping it", () => {
        const overlay = personalConfigFromEnvironment({
            SATENG_CONVERSATION_TABLE: "t",
            SATENG_CONVERSATION_TTL_DAYS: "soon",
        });
        expect(() => PersonalConfigurationSchema.parse(overlay)).toThrow();
    });
});

describe("mergePersonalConfig", () => {
    const file = {
        defaultModel: "claude-sonnet-4-20250514",
        providers: { anthropic: { apiKey: "sk-file", enabled: true } },
        cloud: {
            aws: {
                awsProfile: "dev",
                awsRegion: "us-east-1",
                s3: { bucket: "file-bucket" },
                bedrockKnowledgeBase: { knowledgeBaseId: "FILE_KB" },
            },
        },
    };

    it("returns the file untouched when the environment sets nothing", () => {
        expect(mergePersonalConfig(file, undefined)).toBe(file);
    });

    it("overrides only the blocks the environment sets, keeping the rest of the file", () => {
        const merged = mergePersonalConfig(file, personalConfigFromEnvironment({ SATENG_KB_ID: "ENV_KB" })) as any;

        expect(merged.cloud.aws.bedrockKnowledgeBase).toEqual({ knowledgeBaseId: "ENV_KB" });
        expect(merged.cloud.aws.s3).toEqual({ bucket: "file-bucket" });
        expect(merged.cloud.aws.awsProfile).toBe("dev");
        expect(merged.providers.anthropic.apiKey).toBe("sk-file");
        expect(merged.defaultModel).toBe("claude-sonnet-4-20250514");
    });

    it("does not mutate the file config it was given", () => {
        const snapshot = JSON.stringify(file);
        mergePersonalConfig(
            file,
            personalConfigFromEnvironment({ SATENG_KB_ID: "ENV_KB", SATENG_BEDROCK_REGION: "eu-west-1" }),
        );
        expect(JSON.stringify(file)).toBe(snapshot);
    });
});
