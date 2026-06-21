import { parsePullRequestUrl } from "../../../../src/integrations/github/utils/github-url.util";
import { SCMProvider } from "../../../../src/integrations/scm/scm.model";

describe("parsePullRequestUrl", () => {
    it("parses a GitHub PR URL", () => {
        const result = parsePullRequestUrl("https://github.com/owner/repo/pull/42");
        expect(result).toEqual({ provider: SCMProvider.GITHUB, owner: "owner", repo: "repo", prNumber: 42 });
    });

    it("parses a Bitbucket PR URL", () => {
        const result = parsePullRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/7");
        expect(result).toEqual({ provider: SCMProvider.BITBUCKET, owner: "workspace", repo: "repo", prNumber: 7 });
    });

    it("parses a GitLab MR URL with multi-level sub-group path", () => {
        const result = parsePullRequestUrl("https://gitlab.com/group/subgroup1/subgroup2/project/-/merge_requests/5");
        expect(result).toEqual({
            provider: SCMProvider.GITLAB,
            owner: "group/subgroup1/subgroup2",
            repo: "project",
            prNumber: 5,
        });
    });
});
