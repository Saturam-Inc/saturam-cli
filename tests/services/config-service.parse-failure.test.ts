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
