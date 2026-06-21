import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { GITLAB_API_BASE_URL, GITLAB_API_PATH } from "../constants/gitlab.constant";
import { GitLabDiscussionPosition, GitLabMR } from "../models/gitlab.model";

const logger = getLogger("GitLabService");

@Service()
export class GitLabService {
    constructor(private readonly config: ConfigService) {}

    private async getBaseUrl(): Promise<string> {
        const instanceUrl = await this.config.getGitLabInstanceUrl();
        if (instanceUrl) {
            return instanceUrl.replace(/\/$/, "") + GITLAB_API_PATH;
        }
        return GITLAB_API_BASE_URL;
    }

    private async getHeaders(): Promise<Record<string, string>> {
        const token = await this.config.getGitLabToken();
        return {
            "Private-Token": token,
            "Content-Type": "application/json",
        };
    }

    /** URL-encodes a "namespace/repo" path for use as a GitLab project ID. */
    private encodeProjectId(namespace: string, repo: string): string {
        return encodeURIComponent(`${namespace}/${repo}`);
    }

    public async getMergeRequest(namespace: string, repo: string, mrIid: number): Promise<GitLabMR> {
        const baseUrl = await this.getBaseUrl();
        const headers = await this.getHeaders();
        const projectId = this.encodeProjectId(namespace, repo);
        const response = await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${mrIid}`, { headers });
        if (!response.ok) {
            throw new Error(`Failed to fetch GitLab MR !${mrIid}: ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<GitLabMR>;
    }

    public async getMergeRequestDiff(namespace: string, repo: string, mrIid: number): Promise<string> {
        const baseUrl = await this.getBaseUrl();
        const headers = await this.getHeaders();
        const projectId = this.encodeProjectId(namespace, repo);
        // unidiff=true returns unified diff compatible with the existing diff parser
        const response = await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${mrIid}/diffs?unidiff=true`, {
            headers,
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch GitLab MR diff !${mrIid}: ${response.status} ${response.statusText}`);
        }
        const diffs = (await response.json()) as Array<{ diff: string; new_path: string; old_path: string }>;
        // Re-assemble individual file diffs into a single unified diff string
        return diffs.map((d) => `diff --git a/${d.old_path} b/${d.new_path}\n${d.diff}`).join("\n");
    }

    public async findMergeRequestByBranch(namespace: string, repo: string, branch: string): Promise<number | null> {
        const baseUrl = await this.getBaseUrl();
        const headers = await this.getHeaders();
        const projectId = this.encodeProjectId(namespace, repo);
        const response = await fetch(
            `${baseUrl}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`,
            { headers },
        );

        if (!response.ok) {
            throw new Error(`Failed to search GitLab MRs for branch ${branch}: ${response.status}`);
        }
        const mrs = (await response.json()) as Array<{ iid: number }>;
        return mrs.length > 0 ? mrs[0].iid : null;
    }

    public async postComment(namespace: string, repo: string, mrIid: number, body: string): Promise<void> {
        const baseUrl = await this.getBaseUrl();
        const headers = await this.getHeaders();
        const projectId = this.encodeProjectId(namespace, repo);
        const response = await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${mrIid}/notes`, {
            method: "POST",
            headers,
            body: JSON.stringify({ body }),
        });
        if (!response.ok) {
            throw new Error(`Failed to post GitLab MR comment: ${response.status} ${response.statusText}`);
        }
    }

    public async postDiscussion(
        namespace: string,
        repo: string,
        mrIid: number,
        body: string,
        position: GitLabDiscussionPosition,
    ): Promise<void> {
        const baseUrl = await this.getBaseUrl();
        const headers = await this.getHeaders();
        const projectId = this.encodeProjectId(namespace, repo);
        const response = await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ body, position }),
        });
        if (!response.ok) {
            const errText = await response.text();
            logger.warn(
                `Failed to post GitLab inline comment on ${position.new_path}:${position.new_line}: ${response.status} ${errText}`,
            );
        }
    }
}
