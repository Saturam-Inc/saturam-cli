import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";

const logger = getLogger("BitbucketService");

const BITBUCKET_API_BASE_URL = "https://api.bitbucket.org/2.0";

export interface BitbucketPR {
    id: number;
    title: string;
    description: string;
    state: string;
    source: { branch: { name: string } };
    destination: { branch: { name: string } };
    links: { html: { href: string } };
    author: { display_name: string; nickname: string };
}

export interface BitbucketDiffStat {
    values: Array<{
        status: string;
        old?: { path: string };
        new?: { path: string };
        lines_added: number;
        lines_removed: number;
    }>;
    next?: string;
}

@Service()
export class BitbucketService {
    constructor(private readonly config: ConfigService) {}

    private async getAuthHeaders(): Promise<Record<string, string>> {
        // 1. Env var: app password (Basic auth)
        if (process.env.BITBUCKET_APP_PASSWORD && process.env.BITBUCKET_USERNAME) {
            const encoded = Buffer.from(
                `${process.env.BITBUCKET_USERNAME}:${process.env.BITBUCKET_APP_PASSWORD}`,
            ).toString("base64");
            return { Authorization: `Basic ${encoded}`, Accept: "application/json" };
        }

        // 2. Env var: bearer token
        if (process.env.BITBUCKET_TOKEN) {
            return { Authorization: `Bearer ${process.env.BITBUCKET_TOKEN}`, Accept: "application/json" };
        }

        // 3. Personal config
        const personalConfig = await this.config.loadPersonalConfig();
        if (personalConfig.bitbucketToken && personalConfig.bitbucketUsername) {
            // App password stored in config
            const encoded = Buffer.from(
                `${personalConfig.bitbucketUsername}:${personalConfig.bitbucketToken}`,
            ).toString("base64");
            return { Authorization: `Basic ${encoded}`, Accept: "application/json" };
        }
        if (personalConfig.bitbucketToken) {
            // Access token stored in config
            return { Authorization: `Bearer ${personalConfig.bitbucketToken}`, Accept: "application/json" };
        }

        throw new Error(
            "No Bitbucket credentials found. Set BITBUCKET_TOKEN env var, or run 'sat-cli init' to configure.",
        );
    }

    public async getPullRequest(workspace: string, repo: string, prNumber: number): Promise<BitbucketPR> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(
            `${BITBUCKET_API_BASE_URL}/repositories/${workspace}/${repo}/pullrequests/${prNumber}`,
            { headers },
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch Bitbucket PR #${prNumber}: ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<BitbucketPR>;
    }

    public async getPullRequestDiff(workspace: string, repo: string, prNumber: number): Promise<string> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(
            `${BITBUCKET_API_BASE_URL}/repositories/${workspace}/${repo}/pullrequests/${prNumber}/diff`,
            { headers },
        );
        if (!response.ok) {
            throw new Error(
                `Failed to fetch Bitbucket PR diff #${prNumber}: ${response.status} ${response.statusText}`,
            );
        }
        return response.text();
    }

    public async getDiffStat(workspace: string, repo: string, prNumber: number): Promise<BitbucketDiffStat> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(
            `${BITBUCKET_API_BASE_URL}/repositories/${workspace}/${repo}/pullrequests/${prNumber}/diffstat`,
            { headers },
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch Bitbucket diffstat: ${response.status}`);
        }
        return response.json() as Promise<BitbucketDiffStat>;
    }

    public async postComment(workspace: string, repo: string, prNumber: number, body: string): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(
            `${BITBUCKET_API_BASE_URL}/repositories/${workspace}/${repo}/pullrequests/${prNumber}/comments`,
            {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ content: { raw: body } }),
            },
        );
        if (!response.ok) {
            throw new Error(`Failed to post Bitbucket comment: ${response.status} ${response.statusText}`);
        }
    }

    /** Post a comment inline on a specific file and line. */
    public async postInlineComment(
        workspace: string,
        repo: string,
        prNumber: number,
        file: string,
        line: number,
        body: string,
    ): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(
            `${BITBUCKET_API_BASE_URL}/repositories/${workspace}/${repo}/pullrequests/${prNumber}/comments`,
            {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: { raw: body },
                    inline: { path: file, to: line },
                }),
            },
        );
        if (!response.ok) {
            throw new Error(`Failed to post Bitbucket inline comment: ${response.status} ${response.statusText}`);
        }
    }

    public async findPullRequestByBranch(workspace: string, repo: string, branch: string): Promise<number | null> {
        const headers = await this.getAuthHeaders();
        const query = encodeURIComponent(`source.branch.name="${branch}" AND state="OPEN"`);
        const response = await fetch(
            `${BITBUCKET_API_BASE_URL}/repositories/${workspace}/${repo}/pullrequests?q=${query}`,
            { headers },
        );
        if (!response.ok) {
            throw new Error(`Failed to search Bitbucket PRs: ${response.status}`);
        }
        const data = (await response.json()) as { values: Array<{ id: number }> };
        return data.values.length > 0 ? data.values[0].id : null;
    }
}
