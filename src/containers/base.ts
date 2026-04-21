import { randomUUID } from "crypto";
import Container, { ContainerInstance } from "typedi";
import { TypedCommand } from "../commands/base";
import { Cli } from "../commands/cli";
import { GitService } from "../integrations/github/services/git.service";
import { WorkingDirectory } from "../utils/working-directory";

type ServiceIdentifier<T = unknown> = new (...args: any[]) => T;

export async function getContainer(cwd: string, commandClasses: ServiceIdentifier<TypedCommand>[]) {
    const cliFolder = process.cwd();
    const repoRoot = await GitService.getRepoRootByCwd(cwd).catch(() => cwd);

    const directory = new WorkingDirectory(cwd, cliFolder, repoRoot);
    const container = Container.of(randomUUID());
    container.set(WorkingDirectory, directory);
    container.set(ContainerInstance, container);
    Container.set(WorkingDirectory, directory);

    const resolvedCommands: TypedCommand[] = commandClasses.map((c) => container.get(c));
    const commandsByCategory: Record<string, TypedCommand[]> = {};
    for (const cmd of resolvedCommands) {
        if (!commandsByCategory[cmd.category]) {
            commandsByCategory[cmd.category] = [];
        }
        commandsByCategory[cmd.category].push(cmd);
    }
    container.set("commands", commandsByCategory);

    return container;
}
