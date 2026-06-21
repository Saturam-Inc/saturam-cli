import { Argument, CommanderError, Command as Program } from "commander";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { ConfigService, SessionConfigurationSchema } from "../services/config-service";
import { CommandInputs, TOP_LEVEL_CATEGORIES, TypedCommand } from "./base";
import { readFileSync } from "fs";
import { join } from "path";

// Read package.json for version
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
const CLI_VERSION = packageJson.version;

const logger = getLogger("Cli");

@Service()
export class Cli {
    private program: Program | undefined;

    public constructor(private readonly configService: ConfigService) {}

    public async run(args: string[], commands: Record<string, TypedCommand[]>): Promise<void> {
        const program = await this.getProgram(commands);
        await program.parseAsync(args);
    }

    public async getProgram(commands: Record<string, TypedCommand[]>): Promise<Program> {
        if (this.program) {
            return this.program;
        }

        this.program = new Program();
        this.program.exitOverride(this.handleExit);
        this.program.configureOutput({
            writeOut: (msg) => logger.info(msg),
            writeErr: (msg) => logger.error(msg),
        });
        this.program
            .name("sat-cli")
            .version(CLI_VERSION)
            .description("Saturam Engineering CLI")
            .option("-d, --debug", "Enable debug logging")
            .option("-m, --model <model>", "The AI model to use")
            .option("--quiet", "Suppress output")
            .option("--ci", "Run in CI mode (no interactive prompts)");

        // Add top-level commands
        const topLevelCommands = Object.keys(commands)
            .filter((p) => TOP_LEVEL_CATEGORIES.includes(p as TypedCommand["category"]))
            .flatMap((c) => commands[c]);
        this.addCommandsToProgram(this.program, topLevelCommands);

        // Add category-scoped commands
        const lowLevelCategories = Object.keys(commands).filter(
            (p) => !TOP_LEVEL_CATEGORIES.includes(p as TypedCommand["category"]),
        );
        for (const category of lowLevelCategories) {
            const superCmd = this.program
                .command(category)
                .description(`Commands for the ${category} category.\n\n`)
                .action(() => superCmd.help());
            this.addCommandsToProgram(superCmd, commands[category]);
        }

        return this.program;
    }

    private addCommandsToProgram(program: Program, commands: TypedCommand[]): void {
        for (const command of commands.sort((a, b) => a.name.localeCompare(b.name))) {
            const cmd = program
                .command(command.name)
                .aliases(command.aliases)
                .description(command.description + "\n\n");

            for (const input of command.inputs) {
                if (input.argument) {
                    const a = new Argument(input.name, input.description);
                    a.required = false;
                    cmd.addArgument(a);
                } else if (
                    input.schema instanceof z.ZodBoolean ||
                    (input.schema instanceof z.ZodOptional && input.schema._def.innerType instanceof z.ZodBoolean)
                ) {
                    cmd.option(`--${input.name}`, input.description);
                    cmd.option(`--no-${input.name}`, input.description);
                } else {
                    cmd.option(`--${input.name} <value>`, input.description);
                }
            }

            cmd.action(async (...args) => {
                const opts = cmd.opts();
                const globalOpts = this.program?.opts() ?? {};

                // Inject positional arguments into opts by their declared name.
                // Commander passes positional args as leading elements of ...args,
                // followed by the options object and the command instance.
                const argumentInputs = command.inputs.filter((i) => i.argument);
                for (let i = 0; i < argumentInputs.length; i++) {
                    const val = cmd.processedArgs[i];
                    if (val !== undefined) {
                        (opts as Record<string, unknown>)[argumentInputs[i].name] = val;
                    }
                }

                const session = SessionConfigurationSchema.parse({ ...globalOpts, ...opts });
                await this.configService.setSessionConfiguration(session);
                await command.execute(opts);
            });
        }
    }

    private handleExit(err: CommanderError): void {
        if (err.code === "commander.help") {
            process.exit(0);
        }
        if (err.code !== "commander.executeSubCommandAsync") {
            throw err;
        }
    }
}
