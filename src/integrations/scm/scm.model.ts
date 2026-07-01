export enum SCMProvider {
    GITHUB = "github",
    BITBUCKET = "bitbucket",
    GITLAB = "gitlab",
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

export interface SCMRequestContext {
    instanceUrl?: string;
}

export interface SCMService {
    readonly provider: SCMProvider;

    getPullRequest(owner: string, repo: string, prNumber: number, context?: SCMRequestContext): Promise<PullRequestInfo>;
    getPullRequestDiff(owner: string, repo: string, prNumber: number, context?: SCMRequestContext): Promise<string>;
    postReviewComment(owner: string, repo: string, prNumber: number, body: string, context?: SCMRequestContext): Promise<void>;
    postInlineReview(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        comments: InlineComment[],
        context?: SCMRequestContext,
    ): Promise<void>;
    findPullRequestByBranch(owner: string, repo: string, branch: string, context?: SCMRequestContext): Promise<number | null>;
}
