import { getLogger } from "log4js";
import { z } from "zod";
import { Cli } from "../../src/commands/cli";
import { ConfigService } from "../../src/services/config-service";
import { TypedCommand } from "../../src/commands/base";

jest.mock("log4js", () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { getLogger: () => logger };
});
const mockLogger = getLogger("Cli") as unknown as { warn: jest.Mock; info: jest.Mock };

describe("Cli hyphenated option mapping", () => {
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        mockConfig = {
            setSessionConfiguration: jest.fn().mockResolvedValue(undefined),
        } as any;
    });

    it("maps a hyphenated flag like --project-name back to inputs['project-name'] (not the camelCased key Commander produces)", async () => {
        const execute = jest.fn().mockResolvedValue(undefined);
        const command: TypedCommand = {
            name: "demo",
            description: "synthetic command exercising flag mapping",
            category: "common",
            aliases: [],
            inputs: [
                {
                    name: "configOrSheet",
                    description: "config or sheet",
                    schema: z.string().optional(),
                    argument: true,
                },
                { name: "project-name", description: "project name override", schema: z.string().optional() },
            ],
            execute,
        };

        const cli = new Cli(mockConfig);
        await cli.run(["node", "sat-cli", "demo", "--project-name", "Saturam"], { common: [command] });

        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ "project-name": "Saturam" }));
        expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ projectName: expect.anything() }));
    });

    it("still maps positional arguments and single-word flags correctly", async () => {
        const execute = jest.fn().mockResolvedValue(undefined);
        const command: TypedCommand = {
            name: "review",
            description: "test review command",
            category: "common",
            aliases: [],
            inputs: [
                { name: "target", description: "target", schema: z.string().optional(), argument: true },
                { name: "post", description: "post", schema: z.boolean().optional() },
            ],
            execute,
        };

        const cli = new Cli(mockConfig);
        await cli.run(["node", "sat-cli", "review", "42", "--post"], { common: [command] });

        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ target: "42", post: true }));
    });
});

describe("Cli former command names", () => {
    let mockConfig: jest.Mocked<ConfigService>;
    const execute = jest.fn().mockResolvedValue(undefined);
    const renamed: TypedCommand = {
        name: "lumos",
        description: "chat with a mentor about your projects",
        category: "common",
        aliases: [],
        formerNames: ["onboard", "ob"],
        inputs: [{ name: "new-session", description: "start fresh", schema: z.boolean().optional() }],
        execute,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = { setSessionConfiguration: jest.fn().mockResolvedValue(undefined) } as any;
    });

    it("still runs the command under a former name, with its options, and says what it is called now", async () => {
        await new Cli(mockConfig).run(["node", "sat-cli", "onboard", "--new-session"], { common: [renamed] });

        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ "new-session": true }));
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "'sat-cli onboard' is now 'sat-cli lumos'. The old name still works for now; use 'sat-cli lumos' next time.",
        );
    });

    it("says nothing when the current name is used", async () => {
        await new Cli(mockConfig).run(["node", "sat-cli", "lumos"], { common: [renamed] });

        expect(execute).toHaveBeenCalled();
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("lists only the current name in help, so nobody learns the old one fresh", async () => {
        const help = (await new Cli(mockConfig).getProgram({ common: [renamed] })).helpInformation();

        expect(help).toContain("lumos");
        expect(help).not.toContain("onboard");
        expect(help).not.toMatch(/\bob\b/);
    });
});
