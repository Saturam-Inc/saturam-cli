import ignore from "ignore";
import { Service } from "typedi";
import { BASE_DIFF_EXCLUSIONS, parseDiffByFile, VENDORED_CODE_PATTERNS } from "../../../utils/git-utils";

@Service()
export class GitHubDiffService {
    private readonly exclusionPatterns = [...BASE_DIFF_EXCLUSIONS, ...VENDORED_CODE_PATTERNS];

    public filterDiff(rawDiff: string, additionalPatterns?: string[]): string {
        const ig = ignore();
        ig.add(this.exclusionPatterns);
        if (additionalPatterns?.length) {
            ig.add(additionalPatterns);
        }

        const diffChunks = parseDiffByFile(rawDiff);
        const allFiles = Object.keys(diffChunks);
        const includedFiles = ig.filter(allFiles);

        return includedFiles.map((file: string) => diffChunks[file]).join("\n");
    }
}
