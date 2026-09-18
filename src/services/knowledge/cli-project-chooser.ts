import { select } from "@inquirer/prompts";
import { getLogger } from "log4js";
import { ProjectCandidate } from "./agents/project-router.agent";
import { ProjectChoice, ProjectChooser } from "./answer-flow.service";

const logger = getLogger("ProjectChooser");

/**
 * Interactive project picker. The user is choosing from evidence — each option carries how many
 * chunks that project contributed and what it is — rather than from a bare list of names.
 */
export class InteractiveProjectChooser implements ProjectChooser {
    public async choose(question: string, candidates: ProjectCandidate[]): Promise<ProjectChoice> {
        const choices = candidates.map((candidate) => {
            const matches = candidate.matchCount > 0 ? ` (${candidate.matchCount} matches)` : "";
            const summary = candidate.project.summary ? ` · ${candidate.project.summary}` : "";
            return {
                name: `${candidate.project.displayName}${summary}${matches}`,
                value: { kind: "project", slug: candidate.project.slug } as ProjectChoice,
            };
        });

        try {
            return await select<ProjectChoice>({
                message: `"${question}" could mean a few things — which one?`,
                choices: [
                    ...choices,
                    { name: "Ask across all projects", value: { kind: "all" } as ProjectChoice },
                    { name: "Let me rephrase", value: { kind: "rephrase" } as ProjectChoice },
                ],
            });
        } catch (err) {
            // Ctrl+C during the picker cancels this question, not the whole session.
            if (err instanceof Error && err.name === "ExitPromptError") {
                return { kind: "rephrase" };
            }
            throw err;
        }
    }
}

/**
 * Non-interactive fallback for --ci and piped stdin, where no picker can be shown. Takes the
 * top-ranked candidate and says so, rather than silently guessing or refusing to answer.
 */
export class AutoProjectChooser implements ProjectChooser {
    public async choose(_question: string, candidates: ProjectCandidate[]): Promise<ProjectChoice> {
        const top = candidates[0];
        if (!top) return { kind: "all" };
        logger.info(`Multiple projects matched; assuming "${top.project.displayName}" (non-interactive mode).`);
        return { kind: "project", slug: top.project.slug };
    }
}
