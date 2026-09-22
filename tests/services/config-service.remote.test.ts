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
