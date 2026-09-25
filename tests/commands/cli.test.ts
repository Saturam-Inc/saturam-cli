import { z } from "zod";
import { Cli } from "../../src/commands/cli";
import { ConfigService } from "../../src/services/config-service";
import { TypedCommand } from "../../src/commands/base";

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
