import { SCMProvider } from "../../scm/scm.model";

export interface ParsedPRUrl {
    provider: SCMProvider;
    owner: string;
    repo: string;
    prNumber: number;
    instanceUrl?: string;
}

const GITHUB_PR_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const BITBUCKET_PR_REGEX = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/;
// GitLab MR URLs are identified by the "/-/merge_requests/" path structure, which is GitLab-specific.
// Matches against the URL pathname only (after the host) so the host is never captured.
// Supports self-hosted instances and any depth of sub-group nesting.
const GITLAB_MR_REGEX = /^\/(.+\/[^/?#]+)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/;

function normalizeUrl(url: string): string {
    const trimmed = url.trim();
    if (!/^[a-zA-Z]+:\/\//.test(trimmed)) {
        return "https://" + trimmed;
    }
    return trimmed;
}

export function parsePullRequestUrl(url: string): ParsedPRUrl | null {
    const normalized = normalizeUrl(url);
    const ghMatch = normalized.match(GITHUB_PR_REGEX);
    if (ghMatch) {
        return {
            provider: SCMProvider.GITHUB,
            owner: ghMatch[1],
            repo: ghMatch[2],
            prNumber: parseInt(ghMatch[3], 10),
        };
    }

    const bbMatch = normalized.match(BITBUCKET_PR_REGEX);
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
    let instanceUrl: string | undefined;
    try {
        const parsedUrl = new URL(normalized);
        pathname = parsedUrl.pathname;
        instanceUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    } catch {
        pathname = normalized; // fall back for non-standard URLs (e.g. during tests with partial strings)
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
            instanceUrl,
        };
    }

    return null;
}

export function isPullRequestUrl(url: string): boolean {
    const normalized = normalizeUrl(url);
    if (GITHUB_PR_REGEX.test(normalized) || BITBUCKET_PR_REGEX.test(normalized)) return true;
    try {
        return GITLAB_MR_REGEX.test(new URL(normalized).pathname);
    } catch {
        return GITLAB_MR_REGEX.test(normalized);
    }
}
