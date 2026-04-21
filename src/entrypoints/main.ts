import "dotenv/config";
import "reflect-metadata";

import { getAllCommandsContainer } from "../containers/all-commands";
import { runCli } from "../utils/cli-utils";

async function main(): Promise<void> {
    const cwd = process.env.SATENG_ORIGINAL_CWD ?? process.cwd();
    await runCli(cwd, () => getAllCommandsContainer(cwd));
}

main();
