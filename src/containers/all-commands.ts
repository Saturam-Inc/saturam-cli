import { InitCommand } from "../commands/init-command";
import { ReviewCommand } from "../commands/review-command";
import { getContainer } from "./base";

const ALL_COMMANDS = [InitCommand, ReviewCommand];

export async function getAllCommandsContainer(cwd: string) {
    return getContainer(cwd, ALL_COMMANDS);
}
