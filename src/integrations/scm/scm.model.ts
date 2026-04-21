export enum SCMProvider {
    GITHUB = "github",
    BITBUCKET = "bitbucket",
}

export interface PullRequestInfo {
    number: number;
    title: string;
    body: string;
    state: string;
    sourceBranch: string;
    targetBranch: string;
    url: string;
    author: string;
    changedFiles: number;
    additions: number;
    deletions: number;
}

export interface InlineComment {
    file: string;
    line: number;
    body: string;
}

export interface SCMService {
    readonly provider: SCMProvider;

    getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo>;
    getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;
    postReviewComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
    postInlineReview(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        comments: InlineComment[],
    ): Promise<void>;
    findPullRequestByBranch(owner: string, repo: string, branch: string): Promise<number | null>;
}
