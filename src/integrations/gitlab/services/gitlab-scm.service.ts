import { Service } from "typedi";
import { InlineComment, PullRequestInfo, SCMProvider, SCMRequestContext, SCMService } from "../../scm/scm.model";
import { GitLabDiscussionPosition } from "../models/gitlab.model";
import { GitLabService } from "./gitlab.service";

@Service()
export class GitLabSCMService implements SCMService {
    readonly provider = SCMProvider.GITLAB;

    constructor(private readonly gitlab: GitLabService) {}

    public async getPullRequest(
        namespace: string,
        repo: string,
        mrIid: number,
        context?: SCMRequestContext,
    ): Promise<PullRequestInfo> {
        const [mr, stats] = await Promise.all([
            this.gitlab.getMergeRequest(namespace, repo, mrIid, context),
            this.gitlab.getMergeRequestDiffStats(namespace, repo, mrIid, context),
        ]);
        return {
            number: mr.iid,
            title: mr.title,
            body: mr.description ?? "",
            state: mr.state,
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch,
            url: mr.web_url,
            author: mr.author.username,
            changedFiles: stats.changedFiles || (mr.changes_count !== null ? parseInt(mr.changes_count, 10) : 0),
            additions: stats.additions,
            deletions: stats.deletions,
        };
    }

    public async getPullRequestDiff(
        namespace: string,
        repo: string,
        mrIid: number,
        context?: SCMRequestContext,
    ): Promise<string> {
        return this.gitlab.getMergeRequestDiff(namespace, repo, mrIid, context);
    }

    public async postReviewComment(
        namespace: string,
        repo: string,
        mrIid: number,
        body: string,
        context?: SCMRequestContext,
    ): Promise<void> {
        return this.gitlab.postComment(namespace, repo, mrIid, body, context);
    }

    public async postInlineReview(
        namespace: string,
        repo: string,
        mrIid: number,
        body: string,
        comments: InlineComment[],
        context?: SCMRequestContext,
    ): Promise<void> {
        // Post overall summary first
        await this.gitlab.postComment(namespace, repo, mrIid, body, context);

        if (comments.length === 0) return;

        // Fetch diff_refs (base/start/head SHAs) required by the GitLab discussions position API
        const mr = await this.gitlab.getMergeRequest(namespace, repo, mrIid, context);
        if (!mr.diff_refs) {
            throw new Error(`GitLab MR !${mrIid} is missing diff_refs; cannot post inline comments.`);
        }
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
            await this.gitlab.postDiscussion(namespace, repo, mrIid, c.body, position, context);
        }
    }

    public async findPullRequestByBranch(
        namespace: string,
        repo: string,
        branch: string,
        context?: SCMRequestContext,
    ): Promise<number | null> {
        return this.gitlab.findMergeRequestByBranch(namespace, repo, branch, context);
    }
}
