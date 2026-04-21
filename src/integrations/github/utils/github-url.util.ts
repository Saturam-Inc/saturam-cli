import { SCMProvider } from "../../scm/scm.model";

export interface ParsedPRUrl {
    provider: SCMProvider;
    owner: string;
    repo: string;
    prNumber: number;
}

const GITHUB_PR_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const BITBUCKET_PR_REGEX = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/;

export function parsePullRequestUrl(url: string): ParsedPRUrl | null {
    const ghMatch = url.match(GITHUB_PR_REGEX);
    if (ghMatch) {
        return { provider: SCMProvider.GITHUB, owner: ghMatch[1], repo: ghMatch[2], prNumber: parseInt(ghMatch[3], 10) };
    }

    const bbMatch = url.match(BITBUCKET_PR_REGEX);
    if (bbMatch) {
        return { provider: SCMProvider.BITBUCKET, owner: bbMatch[1], repo: bbMatch[2], prNumber: parseInt(bbMatch[3], 10) };
    }

    return null;
}

export function isPullRequestUrl(url: string): boolean {
    return GITHUB_PR_REGEX.test(url) || BITBUCKET_PR_REGEX.test(url);
}
