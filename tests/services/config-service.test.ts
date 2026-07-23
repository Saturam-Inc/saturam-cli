import { ConfigService, AIProvider } from "../../src/services/config-service";
import { WorkingDirectory } from "../../src/utils/working-directory";

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
});
