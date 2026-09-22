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

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "tok" }),
        );
        const credentials = await service.getCredentials();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl, options] = fetchMock.mock.calls[0];
        expect(calledUrl).toBe("https://example.com/credentials");
        expect(options.redirect).toBe("error");
        expect(credentials).toEqual({
            accessKeyId: "AKIA_TEST",
            secretAccessKey: "SECRET_TEST",
            sessionToken: "SESSION_TEST",
        });
    });

    it("sends the Authorization header when token is configured", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "AKIA_TEST", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "my-token" }),
        );
        await service.getCredentials();

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers.Authorization).toBe("Bearer my-token");
    });

    it("allows loopback http without token and omits Authorization header", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "AKIA_TEST", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(makeConfig({ url: "http://localhost:8000" }));
        await service.getCredentials();

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers.Authorization).toBeUndefined();
    });

    it("throws when non-loopback http is used", async () => {
        const service = new RemoteCredentialService(
            makeConfig({ url: "http://insecure.example.com", token: "tok" }),
        );
        await expect(service.getCredentials()).rejects.toThrow(/Plain HTTP is only allowed for loopback/);
    });

    it("throws when userinfo is embedded in URL", async () => {
        const service = new RemoteCredentialService(
            makeConfig({ url: "https://user:pass@example.com", token: "tok" }),
        );
        await expect(service.getCredentials()).rejects.toThrow(/userinfo/i);
    });

    it("omits Authorization header when token is not configured on remote host", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "AKIA_TEST", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com" }),
        );
        await service.getCredentials();

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers.Authorization).toBeUndefined();
    });

    it("strips trailing slashes from the configured URL", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(jsonResponse({ accessKeyId: "AKIA_TEST", secretAccessKey: "B" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com/", token: "tok" }),
        );
        await service.getCredentials();

        expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/credentials");
    });

    it("accepts PascalCase credential keys and nested Credentials object", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({
                Credentials: {
                    AccessKeyId: "AKIA_TEST",
                    SecretAccessKey: "SECRET",
                    SessionToken: "TOK",
                },
            }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "tok" }),
        );
        const credentials = await service.getCredentials();

        expect(credentials).toEqual({
            accessKeyId: "AKIA_TEST",
            secretAccessKey: "SECRET",
            sessionToken: "TOK",
        });
    });

    it("throws when required credential fields are missing", async () => {
        const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ accessKeyId: "only-one" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "tok" }),
        );
        await expect(service.getCredentials()).rejects.toThrow(/missing accessKeyId or secretAccessKey/i);
    });

    it("throws when temporary STS credentials (ASIA...) lack sessionToken", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({
                AccessKeyId: "ASIA_TEMP_KEY",
                SecretAccessKey: "SECRET",
            }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "tok" }),
        );
        await expect(service.getCredentials()).rejects.toThrow(/without a required sessionToken/i);
    });

    it("throws clear authentication error on HTTP 401 or 403", async () => {
        const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, false, 401));
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "tok" }),
        );
        await expect(service.getCredentials()).rejects.toThrow(/Authentication failed \(HTTP 401\)/);
    });

    it("retries 500 errors and succeeds if next attempt is ok", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse({}, false, 500))
            .mockResolvedValueOnce(
                jsonResponse({ accessKeyId: "AKIA_RETRY", secretAccessKey: "SECRET" }),
            );
        global.fetch = fetchMock as unknown as typeof fetch;

        const service = new RemoteCredentialService(
            makeConfig({ url: "https://example.com", token: "tok" }),
        );
        const creds = await service.getCredentials();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(creds.accessKeyId).toBe("AKIA_RETRY");
    });
});
