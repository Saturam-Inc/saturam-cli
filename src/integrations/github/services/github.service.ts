import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { GITHUB_API_BASE_URL } from "../constants/github.constant";
import { PullRequestFile, PullRequestInfo } from "../models/github.model";

const logger = getLogger("GitHubService");

@Service()
export class GitHubService {
    constructor(private readonly config: ConfigService) {}

    private async getHeaders(): Promise<Record<string, string>> {
        const token = await this.config.getGitHubToken();
        return {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github.v3+json",
        };
    }

    public async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo> {
        const headers = await this.getHeaders();
        const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
        if (!response.ok) {
            throw new Error(`Failed to fetch PR #${prNumber}: ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<PullRequestInfo>;
    }

    public async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
        const token = await this.config.getGitHubToken();
        const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}`, {
            headers: {
                Authorization: `token ${token}`,
                Accept: "application/vnd.github.v3.diff",
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch PR diff #${prNumber}: ${response.status} ${response.statusText}`);
        }
        return response.text();
    }

    public async getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]> {
        const headers = await this.getHeaders();
        const files: PullRequestFile[] = [];
        let page = 1;

        while (true) {
            const response = await fetch(
                `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
                { headers },
            );
            if (!response.ok) {
                throw new Error(`Failed to fetch PR files: ${response.status}`);
            }
            const batch = (await response.json()) as PullRequestFile[];
            files.push(...batch);
            if (batch.length < 100) break;
            page++;
        }

        return files;
    }

    public async findPullRequestByBranch(owner: string, repo: string, branch: string): Promise<number | null> {
        const headers = await this.getHeaders();
        console.log(`URL is:${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`);
        const response = await fetch(
            `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
            { headers },
        );
        if (!response.ok) {
            throw new Error(`Failed to search PRs for branch ${branch}: ${response.status}`);
        }
        const prs = (await response.json()) as Array<{ number: number }>;
        console.log(`PR length: ${prs.length}`);
        return prs.length > 0 ? prs[0].number : null;
    }

    /**
     * Post a review with inline comments on specific lines.
     * Uses GitHub's two-step pending review flow: create review with comments → submit event.
     */
    public async postInlineReview(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        comments: Array<{ file: string; line: number; body: string }>,
    ): Promise<void> {
        if (comments.length === 0) {
            return this.postReviewComment(owner, repo, prNumber, body);
        }

        const headers = await this.getHeaders();

        // Get PR head SHA
        const pr = await this.getPullRequest(owner, repo, prNumber);
        const headSha = pr.head.sha;

        const apiComments = comments.map((c) => ({
            path: c.file,
            line: c.line,
            side: "RIGHT" as const,
            body: c.body,
        }));

        // Step 1: Create pending review with inline comments (omit `event` to keep pending)
        const createResponse = await fetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ commit_id: headSha, comments: apiComments }),
        });

        if (!createResponse.ok) {
            const err = await createResponse.text();
            throw new Error(`Failed to create inline review: ${createResponse.status} ${err}`);
        }

        const { id: reviewId } = (await createResponse.json()) as { id: number };

        // Step 2: Submit the review with the summary body
        const submitResponse = await fetch(
            `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/events`,
            {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ event: "COMMENT", body }),
            },
        );

        if (!submitResponse.ok) {
            const err = await submitResponse.text();
            throw new Error(`Failed to submit inline review: ${submitResponse.status} ${err}`);
        }
    }

    public async postReviewComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
        const headers = await this.getHeaders();
        const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ body, event: "COMMENT" }),
        });
        if (!response.ok) {
            throw new Error(`Failed to post review comment: ${response.status} ${response.statusText}`);
        }
    }
}
