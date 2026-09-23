import { ConfigService, PersonalConfiguration } from "../../src/services/config-service";

function makeService(personal: PersonalConfiguration): ConfigService {
    // WorkingDirectory is unused by getRemoteConfig; pass a minimal stub.
    const service = new ConfigService({ repoRoot: "/tmp" } as any);
    jest.spyOn(service, "loadPersonalConfig").mockResolvedValue(personal);
    return service;
}

describe("ConfigService.getRemoteConfig", () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.SAT_REMOTE_URL;
        delete process.env.SATENG_REMOTE_URL;
        delete process.env.SAT_REMOTE_TOKEN;
        delete process.env.SATENG_REMOTE_TOKEN;
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        jest.restoreAllMocks();
    });

    it("returns undefined when remote is not configured", async () => {
        const service = makeService({ providers: {} } as PersonalConfiguration);
        expect(await service.getRemoteConfig()).toBeUndefined();
    });

    it("returns the configured URL and token from config", async () => {
        const service = makeService({
            providers: {},
            remote: { url: "https://custom.example.com", token: "tok" },
        } as PersonalConfiguration);

        expect(await service.getRemoteConfig()).toEqual({
            url: "https://custom.example.com",
            token: "tok",
        });
    });

    it("merges env URL with config token", async () => {
        process.env.SAT_REMOTE_URL = "https://env.example.com";
        const service = makeService({
            providers: {},
            remote: { url: "https://config.example.com", token: "config-tok" },
        } as PersonalConfiguration);

        const result = await service.getRemoteConfig();
        expect(result).toEqual({
            url: "https://env.example.com",
            token: "config-tok",
        });
    });

    it("merges env token with config URL", async () => {
        process.env.SAT_REMOTE_TOKEN = "env-tok";
        const service = makeService({
            providers: {},
            remote: { url: "https://config.example.com", token: "config-tok" },
        } as PersonalConfiguration);

        const result = await service.getRemoteConfig();
        expect(result).toEqual({
            url: "https://config.example.com",
            token: "env-tok",
        });
    });

    it("returns undefined when neither config nor env provides a URL", async () => {
        const service = makeService({
            providers: {},
            remote: { url: "" as unknown as string },
        } as PersonalConfiguration);

        const result = await service.getRemoteConfig();
        expect(result).toBeUndefined();
    });
});

describe("RemoteConfigSchema validation", () => {
    const { RemoteConfigSchema } = require("../../src/services/config-service");

    it("accepts loopback URL without token", () => {
        const result = RemoteConfigSchema.safeParse({ url: "http://localhost:8000" });
        expect(result.success).toBe(true);
    });

    it("accepts loopback 127.0.0.1 URL without token", () => {
        const result = RemoteConfigSchema.safeParse({ url: "http://127.0.0.1:8000" });
        expect(result.success).toBe(true);
    });

    it("accepts non-loopback HTTPS URL with token", () => {
        const result = RemoteConfigSchema.safeParse({ url: "https://api.example.com", token: "secret" });
        expect(result.success).toBe(true);
    });

    it("rejects non-loopback URL without token", () => {
        const result = RemoteConfigSchema.safeParse({ url: "https://api.example.com" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toMatch(/Authentication token is required/);
        }
    });

    it("rejects non-loopback URL with empty/whitespace token", () => {
        const result = RemoteConfigSchema.safeParse({ url: "https://api.example.com", token: "   " });
        expect(result.success).toBe(false);
    });
});
