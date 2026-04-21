export interface GitLabDiffRefs {
    base_sha: string;
    head_sha: string;
    start_sha: string;
}

export interface GitLabMR {
    iid: number;
    title: string;
    description: string | null;
    state: string;
    source_branch: string;
    target_branch: string;
    web_url: string;
    author: { username: string; name: string };
    changes_count: string | null;
    additions: number;
    deletions: number;
    diff_refs: GitLabDiffRefs;
}

export interface GitLabDiscussionPosition {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    position_type: "text";
    new_path: string;
    new_line: number;
}
