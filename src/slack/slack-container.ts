import { randomUUID } from "crypto";
import Container, { ContainerInstance } from "typedi";
import { WorkingDirectory } from "../utils/working-directory";

/**
 * The dependency container for the Slack bot's processes. The CLI's container (containers/base.ts)
 * resolves a git repository and registers commands; a server has neither, only the working
 * directory ConfigService needs to look for (and not find) a project config.
 *
 * Built once per process and reused across invocations, so a warm Lambda keeps its SDK clients,
 * cached credentials and model instances.
 */
let container: ContainerInstance | undefined;

export function getSlackContainer(): ContainerInstance {
    if (container) return container;

    const cwd = process.cwd();
    const directory = new WorkingDirectory(cwd, cwd, cwd);
    container = Container.of(`slack-${randomUUID()}`);
    container.set(WorkingDirectory, directory);
    container.set(ContainerInstance, container);
    Container.set(WorkingDirectory, directory);
    return container;
}
