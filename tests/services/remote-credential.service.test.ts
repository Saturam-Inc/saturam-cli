import { RemoteCredentialService } from "../../src/services/remote-credential.service";
import type { ConfigService, RemoteConfig } from "../../src/services/config-service";

function makeConfig(remote?: RemoteConfig): ConfigService {
    return {
        getRemoteConfig: jest.fn().mockResolvedValue(remote),
    } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        json: async () => body,
    } as unknown as Response;
}

describe("RemoteCredentialService", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it("throws when remote mode is not configured", async () => {
        const service = new RemoteCredentialService(makeConfig(undefined));
        await expect(service.getCredentials()).rejects.toThrow(/not configured/i);
    });

    it("requests {url}/credentials and maps the response to AWS credentials", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({
                accessKeyId: "AKIA_TEST",
                secretAccessKey: "SECRET_TEST",
                sessionToken: "SESSION_TEST",
            }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "https://example.com" }));
        const credentials = await service.getCredentials();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl] = fetchMock.mock.calls[0];
        expect(calledUrl).toBe("https://example.com/credentials");
        expect(credentials).toEqual({
            accessKeyId: "AKIA_TEST",
            secretAccessKey: "SECRET_TEST",
            sessionToken: "SESSION_TEST",
        });
    });

    it("sends the Authorization header only when a token is configured", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "A", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "my-token" }),
        );
        await service.getCredentials();

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers.Authorization).toBe("Bearer my-token");
    });

    it("omits the Authorization header when no token is configured", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "A", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "https://example.com" }));
        await service.getCredentials();

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers.Authorization).toBeUndefined();
    });

    it("strips trailing slashes from the configured URL", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "A", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "https://example.com/" }));
        await service.getCredentials();

        expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/credentials");
    });

    it("accepts PascalCase credential keys from the response", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({ AccessKeyId: "AKIA", SecretAccessKey: "SECRET", SessionToken: "TOK" }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "https://example.com" }));
        const credentials = await service.getCredentials();

        expect(credentials).toEqual({
            accessKeyId: "AKIA",
            secretAccessKey: "SECRET",
            sessionToken: "TOK",
        });
    });

    it("throws when required credential fields are missing", async () => {
        const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ accessKeyId: "only-one" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "https://example.com" }));
        await expect(service.getCredentials()).rejects.toThrow(/missing/i);
    });

    it("throws when the endpoint returns a non-OK status", async () => {
        const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, false, 500));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "https://example.com" }));
        await expect(service.getCredentials()).rejects.toThrow(/HTTP 500/);
    });
});
