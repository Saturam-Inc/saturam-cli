import { CommanderError } from "commander";
import { ContainerInstance } from "typedi";
import { Cli } from "../commands/cli";
import { configureLogging, shimConsole, waitForLogsToFlush } from "./logging-utils";

async function runCliInner(cwd: string, getContainer: () => Promise<ContainerInstance>): Promise<void> {
    let args = [...process.argv];
    if (args.length === 2 && process.env.SATENG_CLI_COMMAND) {
        args = args.concat(process.env.SATENG_CLI_COMMAND.split(" "));
    }

    await configureLogging(args, cwd);
    shimConsole();

    const container = await getContainer();
    const cli = container.get(Cli);
    const commands = container.get("commands") as Record<string, any>;
    await cli.run(args, commands);
}

export async function runCli(cwd: string, getContainer: () => Promise<ContainerInstance>): Promise<void> {
    process.on("exit", () => {
        process.stdin.setRawMode?.(false);
    });

    try {
        await runCliInner(cwd, getContainer);
        await waitForLogsToFlush();
        process.exit(0);
    } catch (error) {
        await waitForLogsToFlush();

        if (error instanceof CommanderError && error.exitCode === 0) {
            process.exit(0);
        }

        const errorString = error instanceof Error ? error.toString() : String(error);
        process.stderr.write(errorString + "\n");
        process.exit(1);
    }
}
