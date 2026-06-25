import { GitService } from "../../../src/integrations/github/services/git.service";

describe("GitService.parseOwnerAndRepo", () => {
    it("parses a standard SSH URL (2-level path)", () => {
        const result = GitService.parseOwnerAndRepo("git@github.com:owner/repo.git");
        expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses a standard HTTPS URL (2-level path)", () => {
        const result = GitService.parseOwnerAndRepo("https://github.com/owner/repo.git");
        expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses a GitLab SSH URL with 3-level sub-group path", () => {
        const result = GitService.parseOwnerAndRepo("git@gitlab.com:group/subgroup1/subgroup2/project.git");
        expect(result).toEqual({ owner: "group/subgroup1/subgroup2", repo: "project" });
    });
});
