import { ConfigService } from "../../src/services/config-service";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

jest.mock("fs", () => ({
    ...jest.requireActual("fs"),
    existsSync: jest.fn(),
}));

jest.mock("fs/promises", () => ({
    ...jest.requireActual("fs/promises"),
    readFile: jest.fn(),
}));

describe("ConfigService loadPersonalConfig resilience", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("preserves valid tokens and providers even if defaultModel is invalid", async () => {
        (existsSync as jest.Mock).mockReturnValue(true);
        const corruptConfigJson = JSON.stringify({
            defaultProvider: "bedrock",
            defaultModel: "invalid-non-existent-model-xyz",
            githubToken: "my-secret-gh-token",
            providers: {
                bedrock: { enabled: true, awsRegion: "us-east-1" },
            },
            remote: { url: "https://remote.example.com", token: "my-remote-token" },
        });
        (readFile as jest.Mock).mockResolvedValue(corruptConfigJson);

        const service = new ConfigService({ repoRoot: "/tmp" } as any);
        const loaded = await service.loadPersonalConfig();

        expect(loaded.githubToken).toBe("my-secret-gh-token");
        expect(loaded.providers?.bedrock).toEqual({ enabled: true, awsRegion: "us-east-1" });
        expect(loaded.remote).toEqual({ url: "https://remote.example.com", token: "my-remote-token" });
        expect(loaded.defaultModel).toBeUndefined();
    });

    it("preserves all scalar tokens, emails, and SCM instance URLs in PersonalConfigurationSchema during fallback recovery", async () => {
        (existsSync as jest.Mock).mockReturnValue(true);
        const corruptConfigJson = JSON.stringify({
            defaultProvider: "bedrock",
            defaultModel: "invalid-model",
            githubToken: "gh-token-123",
            bitbucketToken: "bb-token-456",
            bitbucketEmail: "user@example.com",
            bitbucketUsername: "bb-user",
            gitlabToken: "gl-token-789",
            gitlabInstanceUrl: "https://gitlab.custom.internal",
            providers: {
                bedrock: { enabled: true, awsRegion: "us-west-2" },
                openai: { enabled: "not-a-boolean-value" as any }, // Corrupted provider
            },
            remote: { url: "https://remote.example.com", token: "valid-token" },
        });
        (readFile as jest.Mock).mockResolvedValue(corruptConfigJson);

        const service = new ConfigService({ repoRoot: "/tmp" } as any);
        const loaded = await service.loadPersonalConfig();

        expect(loaded.githubToken).toBe("gh-token-123");
        expect(loaded.bitbucketToken).toBe("bb-token-456");
        expect(loaded.bitbucketEmail).toBe("user@example.com");
        expect(loaded.bitbucketUsername).toBe("bb-user");
        expect(loaded.gitlabToken).toBe("gl-token-789");
        expect(loaded.gitlabInstanceUrl).toBe("https://gitlab.custom.internal");
        expect(loaded.providers?.bedrock).toEqual({ enabled: true, awsRegion: "us-west-2" });
        expect(loaded.providers?.openai).toBeUndefined(); // Corrupted provider dropped
        expect(loaded.remote).toEqual({ url: "https://remote.example.com", token: "valid-token" });
    });

    it("fails closed and throws when remote configuration block is corrupted in config file", async () => {
        (existsSync as jest.Mock).mockReturnValue(true);
        const corruptRemoteConfigJson = JSON.stringify({
            defaultProvider: "bedrock",
            defaultModel: "invalid-model",
            providers: {
                bedrock: { enabled: true, awsRegion: "us-east-1" },
            },
            // Corrupted remote config (e.g. non-loopback URL with missing token)
            remote: { url: "https://remote.example.com" },
        });
        (readFile as jest.Mock).mockResolvedValue(corruptRemoteConfigJson);

        const service = new ConfigService({ repoRoot: "/tmp" } as any);
        await expect(service.loadPersonalConfig()).rejects.toThrow(/Corrupted remote credential configuration/);
    });
});
