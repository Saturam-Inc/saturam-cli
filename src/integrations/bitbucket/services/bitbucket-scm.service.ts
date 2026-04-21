import { Service } from "typedi";
import { InlineComment, PullRequestInfo, SCMProvider, SCMService } from "../../scm/scm.model";
import { BitbucketService } from "./bitbucket.service";

@Service()
export class BitbucketSCMService implements SCMService {
    readonly provider = SCMProvider.BITBUCKET;

    constructor(private readonly bitbucket: BitbucketService) {}

    public async getPullRequest(workspace: string, repo: string, prNumber: number): Promise<PullRequestInfo> {
        const pr = await this.bitbucket.getPullRequest(workspace, repo, prNumber);
        const diffstat = await this.bitbucket.getDiffStat(workspace, repo, prNumber);

        let additions = 0;
        let deletions = 0;
        for (const file of diffstat.values) {
            additions += file.lines_added;
            deletions += file.lines_removed;
        }

        return {
            number: pr.id,
            title: pr.title,
            body: pr.description ?? "",
            state: pr.state,
            sourceBranch: pr.source.branch.name,
            targetBranch: pr.destination.branch.name,
            url: pr.links.html.href,
            author: pr.author.nickname ?? pr.author.display_name,
            changedFiles: diffstat.values.length,
            additions,
            deletions,
        };
    }

    public async getPullRequestDiff(workspace: string, repo: string, prNumber: number): Promise<string> {
        return this.bitbucket.getPullRequestDiff(workspace, repo, prNumber);
    }

    public async postReviewComment(workspace: string, repo: string, prNumber: number, body: string): Promise<void> {
        return this.bitbucket.postComment(workspace, repo, prNumber, body);
    }

    public async postInlineReview(
        workspace: string,
        repo: string,
        prNumber: number,
        body: string,
        comments: InlineComment[],
    ): Promise<void> {
        // Bitbucket doesn't have a batched "review" concept like GitHub.
        // Post the summary, then each inline comment sequentially.
        await this.bitbucket.postComment(workspace, repo, prNumber, body);
        for (const c of comments) {
            await this.bitbucket.postInlineComment(workspace, repo, prNumber, c.file, c.line, c.body);
        }
    }

    public async findPullRequestByBranch(workspace: string, repo: string, branch: string): Promise<number | null> {
        return this.bitbucket.findPullRequestByBranch(workspace, repo, branch);
    }
}
