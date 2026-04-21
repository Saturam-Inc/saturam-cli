import { Service } from "typedi";
import { InlineComment, PullRequestInfo, SCMProvider, SCMService } from "../../scm/scm.model";
import { GitHubService } from "./github.service";

@Service()
export class GitHubSCMService implements SCMService {
    readonly provider = SCMProvider.GITHUB;

    constructor(private readonly github: GitHubService) {}

    public async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo> {
        const pr = await this.github.getPullRequest(owner, repo, prNumber);
        return {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            sourceBranch: pr.head.ref,
            targetBranch: pr.base.ref,
            url: pr.html_url,
            author: pr.user.login,
            changedFiles: pr.changed_files,
            additions: pr.additions,
            deletions: pr.deletions,
        };
    }

    public async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
        return this.github.getPullRequestDiff(owner, repo, prNumber);
    }

    public async postReviewComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
        return this.github.postReviewComment(owner, repo, prNumber, body);
    }

    public async postInlineReview(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        comments: InlineComment[],
    ): Promise<void> {
        return this.github.postInlineReview(owner, repo, prNumber, body, comments);
    }

    public async findPullRequestByBranch(owner: string, repo: string, branch: string): Promise<number | null> {
        return this.github.findPullRequestByBranch(owner, repo, branch);
    }
}
