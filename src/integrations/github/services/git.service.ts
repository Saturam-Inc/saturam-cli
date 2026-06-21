import { execSync } from "child_process";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { WorkingDirectory } from "../../../utils/working-directory";

const logger = getLogger("GitService");

@Service()
export class GitService {
    constructor(private readonly dir: WorkingDirectory) {}

    public static async getRepoRootByCwd(cwd: string): Promise<string> {
        return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
    }

    public async getCurrentBranch(): Promise<string> {
        return execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: this.dir.repoRoot,
            encoding: "utf8",
        }).trim();
    }

    public async getRemoteUrl(): Promise<string> {
        return execSync("git remote get-url origin", {
            cwd: this.dir.repoRoot,
            encoding: "utf8",
        }).trim();
    }

    public async getDiff(base: string, head?: string): Promise<string> {
        const headRef = head ?? "HEAD";
        return execSync(`git diff ${base}...${headRef}`, {
            cwd: this.dir.repoRoot,
            encoding: "utf8",
            maxBuffer: 50 * 1024 * 1024,
        });
    }

    public async getOwnerAndRepo(): Promise<{ owner: string; repo: string }> {
        const remoteUrl = await this.getRemoteUrl();
        return GitService.parseOwnerAndRepo(remoteUrl);
    }

    public static parseOwnerAndRepo(remoteUrl: string): { owner: string; repo: string } {
        let fullPath: string;
        if (remoteUrl.startsWith("http://") || remoteUrl.startsWith("https://")) {
            // HTTPS: https://host/group/sub/repo.git
            const parsed = new URL(remoteUrl);
            fullPath = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
        } else {
            // SSH: git@host:group/sub/repo.git
            const colonIdx = remoteUrl.lastIndexOf(":");
            fullPath = remoteUrl.slice(colonIdx + 1).replace(/\.git$/, "");
        }
        const lastSlash = fullPath.lastIndexOf("/");
        if (lastSlash === -1) {
            throw new Error(`Could not parse owner/repo from remote URL: ${remoteUrl}`);
        }
        return { owner: fullPath.slice(0, lastSlash), repo: fullPath.slice(lastSlash + 1) };
    }
}
