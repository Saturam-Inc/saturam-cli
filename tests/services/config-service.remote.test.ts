import { ConfigService, DEFAULT_REMOTE_URL, PersonalConfiguration } from "../../src/services/config-service";

function makeService(personal: PersonalConfiguration): ConfigService {
    // WorkingDirectory is unused by getRemoteConfig; pass a minimal stub.
    const service = new ConfigService({ repoRoot: "/tmp" } as any);
    jest.spyOn(service, "loadPersonalConfig").mockResolvedValue(personal);
    return service;
}

describe("ConfigService.getRemoteConfig", () => {
    it("returns undefined when remote is not configured", async () => {
        const service = makeService({ providers: {} } as PersonalConfiguration);
        expect(await service.getRemoteConfig()).toBeUndefined();
    });

    it("returns the configured URL and token", async () => {
        const service = makeService({
            providers: {},
            remote: { url: "https://custom.example.com", token: "tok" },
        } as PersonalConfiguration);

        expect(await service.getRemoteConfig()).toEqual({
            url: "https://custom.example.com",
            token: "tok",
        });
    });

    it("applies the default URL when remote is set without a URL value", async () => {
        const service = makeService({
            providers: {},
            remote: { url: "" as unknown as string },
        } as PersonalConfiguration);

        const result = await service.getRemoteConfig();
        expect(result?.url).toBe(DEFAULT_REMOTE_URL);
        expect(result?.token).toBeUndefined();
    });
});
