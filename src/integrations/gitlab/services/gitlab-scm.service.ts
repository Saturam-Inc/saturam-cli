import { Service } from "typedi";
import { InlineComment, PullRequestInfo, SCMProvider, SCMService } from "../../scm/scm.model";
import { GitLabDiscussionPosition } from "../models/gitlab.model";
import { GitLabService } from "./gitlab.service";

@Service()
export class GitLabSCMService implements SCMService {
    readonly provider = SCMProvider.GITLAB;

    constructor(private readonly gitlab: GitLabService) {}

    public async getPullRequest(namespace: string, repo: string, mrIid: number): Promise<PullRequestInfo> {
        const mr = await this.gitlab.getMergeRequest(namespace, repo, mrIid);
        return {
            number: mr.iid,
            title: mr.title,
            body: mr.description ?? "",
            state: mr.state,
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch,
            url: mr.web_url,
            author: mr.author.username,
            changedFiles: mr.changes_count !== null ? parseInt(mr.changes_count, 10) : 0,
            additions: 0,
            deletions: 0,
        };
    }

    public async getPullRequestDiff(namespace: string, repo: string, mrIid: number): Promise<string> {
        return this.gitlab.getMergeRequestDiff(namespace, repo, mrIid);
    }

    public async postReviewComment(namespace: string, repo: string, mrIid: number, body: string): Promise<void> {
        return this.gitlab.postComment(namespace, repo, mrIid, body);
    }

    public async postInlineReview(
        namespace: string,
        repo: string,
        mrIid: number,
        body: string,
        comments: InlineComment[],
    ): Promise<void> {
        // Post overall summary first
        await this.gitlab.postComment(namespace, repo, mrIid, body);

        if (comments.length === 0) return;

        // Fetch diff_refs (base/start/head SHAs) required by the GitLab discussions position API
        const mr = await this.gitlab.getMergeRequest(namespace, repo, mrIid);
        const { base_sha, start_sha, head_sha } = mr.diff_refs;

        for (const c of comments) {
            const position: GitLabDiscussionPosition = {
                base_sha,
                start_sha,
                head_sha,
                position_type: "text",
                new_path: c.file,
                new_line: c.line,
            };
            await this.gitlab.postDiscussion(namespace, repo, mrIid, c.body, position);
        }
    }

    public async findPullRequestByBranch(namespace: string, repo: string, branch: string): Promise<number | null> {
        return this.gitlab.findMergeRequestByBranch(namespace, repo, branch);
    }
}
