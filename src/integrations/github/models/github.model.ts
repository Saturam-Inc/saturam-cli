export interface PullRequestInfo {
    number: number;
    title: string;
    body: string;
    state: string;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    html_url: string;
    user: { login: string };
    changed_files: number;
    additions: number;
    deletions: number;
}

export interface PullRequestFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

export interface ParsedGitHubUrl {
    owner: string;
    repo: string;
    prNumber?: number;
}
