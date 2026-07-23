import { InitCommand } from "../../src/commands/init-command";
import { ConfigService } from "../../src/services/config-service";
import { select, input, password } from "@inquirer/prompts";

jest.mock("@inquirer/prompts", () => ({
    select: jest.fn(),
    input: jest.fn(),
    password: jest.fn(),
    confirm: jest.fn(),
    checkbox: jest.fn(),
}));

describe("InitCommand Platform Config Flow", () => {
    let command: InitCommand;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            loadPersonalConfig: jest.fn().mockResolvedValue({}),
            savePersonalConfig: jest.fn().mockResolvedValue(undefined),
            getPersonalConfigPath: jest.fn().mockReturnValue("/mock/personal/config.json"),
        } as any;

        command = new InitCommand(mockConfig);
    });

    it("should configure Atlassian credentials from top-level menu", async () => {
        // New UX: single select → "atlassian" (no nested Onboarding submenu)
        (select as jest.Mock).mockResolvedValueOnce("atlassian");
        (input as jest.Mock).mockResolvedValueOnce("test@example.com");
        (password as jest.Mock).mockResolvedValueOnce("secret_api_token");

        await command.execute({});

        expect(select).toHaveBeenCalledTimes(1);
        expect(input).toHaveBeenCalled();
        expect(password).toHaveBeenCalled();
        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            atlassianEmail: "test@example.com",
            atlassianToken: "secret_api_token",
        });
    });

    it("should configure Google credentials from top-level menu", async () => {
        // New UX: single select → "google" (no nested Onboarding submenu)
        (select as jest.Mock).mockResolvedValueOnce("google");
        (password as jest.Mock).mockResolvedValueOnce("ya29.google_token");

        await command.execute({});

        expect(select).toHaveBeenCalledTimes(1);
        expect(password).toHaveBeenCalled();
        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            googleAccessToken: "ya29.google_token",
        });
    });
});
