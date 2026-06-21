import { SCMProvider } from "../../scm/scm.model";

export interface ParsedPRUrl {
    provider: SCMProvider;
    owner: string;
    repo: string;
    prNumber: number;
}

const GITHUB_PR_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const BITBUCKET_PR_REGEX = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/;
// GitLab MR URLs are identified by the "/-/merge_requests/" path structure, which is GitLab-specific.
// Matches against the URL pathname only (after the host) so the host is never captured.
// Supports self-hosted instances and any depth of sub-group nesting.
const GITLAB_MR_REGEX = /^\/([^?#]+)\/-\/merge_requests\/(\d+)/;

export function parsePullRequestUrl(url: string): ParsedPRUrl | null {
    const ghMatch = url.match(GITHUB_PR_REGEX);
    if (ghMatch) {
        return {
            provider: SCMProvider.GITHUB,
            owner: ghMatch[1],
            repo: ghMatch[2],
            prNumber: parseInt(ghMatch[3], 10),
        };
    }

    const bbMatch = url.match(BITBUCKET_PR_REGEX);
    if (bbMatch) {
        return {
            provider: SCMProvider.BITBUCKET,
            owner: bbMatch[1],
            repo: bbMatch[2],
            prNumber: parseInt(bbMatch[3], 10),
        };
    }

    // Parse pathname separately so the host is never included in the captured path.
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = url; // fall back for non-standard URLs (e.g. during tests with partial strings)
    }
    const glMatch = pathname.match(GITLAB_MR_REGEX);
    if (glMatch) {
        const fullPath = glMatch[1]; // e.g. "group/sub1/sub2/project"
        const lastSlash = fullPath.lastIndexOf("/");
        const owner = fullPath.slice(0, lastSlash);
        const repo = fullPath.slice(lastSlash + 1);
        return {
            provider: SCMProvider.GITLAB,
            owner,
            repo,
            prNumber: parseInt(glMatch[2], 10),
        };
    }

    return null;
}

export function isPullRequestUrl(url: string): boolean {
    if (GITHUB_PR_REGEX.test(url) || BITBUCKET_PR_REGEX.test(url)) return true;
    try {
        return GITLAB_MR_REGEX.test(new URL(url).pathname);
    } catch {
        return GITLAB_MR_REGEX.test(url);
    }
}
