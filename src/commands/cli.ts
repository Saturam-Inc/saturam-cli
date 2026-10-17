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
            this.wire(program, cmd, command);

            // A name the command used to go by still runs it, so a habit or a script written
            // against it is not broken by a rename, but it says what the command is called now
            // and stays out of the help listing so nobody learns it fresh.
            for (const formerName of command.formerNames ?? []) {
                const old = program
                    .command(formerName, { hidden: true })
                    .description(
                        `Former name of '${command.name}'. Use '${this.pathOf(program, command.name)}' instead.\n\n`,
                    );
                this.wire(program, old, command, formerName);
            }
        }
    }

    /** Attaches a command's inputs and action to `cmd`: the command itself, or one of its former names. */
    private wire(program: Program, cmd: Program, command: TypedCommand, formerName?: string): void {
        // A command with no positional input treats a stray one as a mistake — most likely
        // an invocation written against an argument the command used to accept (`lumos`
        // once took a spreadsheet). Commander ignores excess arguments by default, which
        // would turn that into a silent success in whatever script is still running it.
        if (!command.inputs.some((input) => input.argument)) {
            cmd.allowExcessArguments(false);
        }

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
            if (formerName) {
                const current = this.pathOf(program, command.name);
                logger.warn(
                    `'${this.pathOf(program, formerName)}' is now '${current}'. The old name still works for now; use '${current}' next time.`,
                );
            }
            const opts = cmd.opts();
            const positionalArgs = args.slice(0, command.inputs.filter((input) => input.argument).length);
            const argumentInputs = command.inputs
                .filter((input) => input.argument)
                .reduce<Record<string, unknown>>((acc, input, index) => {
                    const value = positionalArgs[index];
                    if (value !== undefined) acc[input.name] = value;
                    return acc;
                }, {});
            // Commander camelCases multi-word option flags (e.g. --project-name -> opts().projectName),
            // so map each option back to its declared (possibly hyphenated) input.name.
            const optionInputs = command.inputs
                .filter((input) => !input.argument)
                .reduce<Record<string, unknown>>((acc, input) => {
                    const camelKey = input.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                    if (opts[camelKey] !== undefined) acc[input.name] = opts[camelKey];
                    return acc;
                }, {});
            const globalOpts = this.program?.opts() ?? {};

            const session = SessionConfigurationSchema.parse({ ...globalOpts, ...opts });
            await this.configService.setSessionConfiguration(session);
            await command.execute({ ...optionInputs, ...argumentInputs });
        });
    }

    /** How the command is typed: `sat-cli name`, or `sat-cli <category> name` for a category-scoped one. */
    private pathOf(program: Program, name: string): string {
        return program === this.program ? `sat-cli ${name}` : `sat-cli ${program.name()} ${name}`;
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
