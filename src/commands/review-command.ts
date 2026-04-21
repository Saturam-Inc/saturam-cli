import { confirm } from "@inquirer/prompts";
import { readFile } from "fs/promises";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { GitService } from "../integrations/github/services/git.service";
import { GitHubDiffService } from "../integrations/github/services/github-diff.service";
import { isPullRequestUrl, parsePullRequestUrl } from "../integrations/github/utils/github-url.util";
import { SCMFactory } from "../integrations/scm/scm-factory.service";
import { InlineComment, SCMService } from "../integrations/scm/scm.model";
import { ConfigService } from "../services/config-service";
import { AuditResult, Finding } from "../services/review/finding-parser.service";
import { MultiAgentReviewService } from "../services/review/multi-agent-review.service";
// Line numbers are resolved by the finding parser using diff content directly
import { TypedCommand, TypedInputs } from "./base";

const logger = getLogger("ReviewCommand");

const INPUTS = [
    {
        name: "target",
        description: "PR number, PR URL, or branch name to review (defaults to current branch)",
        schema: z.string().optional(),
        argument: true,
    },
    {
        name: "post",
        description: "Post the review as inline comments on the PR",
        schema: z.boolean().optional(),
    },
    {
        name: "auto",
        description: "Skip the user approval step (useful in CI)",
        schema: z.boolean().optional(),
    },
    {
        name: "keep-artifacts",
        description: "Keep review artifacts in .context/reviews/ (default: clean up)",
        schema: z.boolean().optional(),
    },
    {
        name: "ticket",
        description: "Inline ticket context, or path to a file with ticket requirements",
        schema: z.string().optional(),
    },
    {
        name: "self",
        description: "Self-review mode: display results in terminal only, do not post to GitHub/Bitbucket",
        schema: z.boolean().optional(),
    },
] as const;

@Service()
export class ReviewCommand implements TypedCommand<typeof INPUTS> {
    readonly name = "review";
    readonly description = "Multi-agent AI code review with audit (supports GitHub and Bitbucket)";
    readonly category = "common" as const;
    readonly aliases = ["rv", "r"];
    readonly inputs = INPUTS;

    constructor(
        private readonly git: GitService,
        private readonly diffService: GitHubDiffService,
        private readonly scmFactory: SCMFactory,
        private readonly multiAgent: MultiAgentReviewService,
        private readonly config: ConfigService,
    ) {}

    public async execute(inputs: TypedInputs<typeof INPUTS>): Promise<void> {
        const { scm, owner, repo, prNumber } = await this.resolveTarget(inputs.target);
        const session = this.config.getSessionConfiguration();
        const autoMode = inputs.auto || session.ci;

        logger.info(`Reviewing PR #${prNumber} in ${owner}/${repo} (${scm.provider})...`);

        // Phase 0: Gather context
        const [pr, rawDiff, ticketContext] = await Promise.all([
            scm.getPullRequest(owner, repo, prNumber),
            scm.getPullRequestDiff(owner, repo, prNumber),
            this.resolveTicketContext(inputs.ticket),
        ]);

        const filteredDiff = this.diffService.filterDiff(rawDiff);
        if (!filteredDiff.trim()) {
            logger.info("No reviewable changes found in this PR.");
            return;
        }

        logger.info(`PR: ${pr.title}`);
        const statsLine =
            pr.additions === 0 && pr.deletions === 0
                ? `${pr.changedFiles} files changed`
                : `+${pr.additions}/-${pr.deletions}, ${pr.changedFiles} files`;
        logger.info(`  ${statsLine}`);
        logger.info("");

        // Phases 1-3: Multi-agent review
        const result = await this.multiAgent.run({
            prNumber,
            pr,
            diff: filteredDiff,
            ticketContext,
        });

        const { audit } = result;

        // Log findings
        logger.info(`\n${audit.findings.length} finding(s) from audit:`);
        for (const f of audit.findings) {
            logger.info(
                `  [${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.title || f.description.slice(0, 60)}`,
            );
        }

        // Phase 4: Show audit
        const auditMd = this.multiAgent.findingParser.formatAuditMarkdown(audit, prNumber);
        if (!autoMode || inputs.self) {
            logger.info("\n--- Audit Review ---\n");
            logger.info(auditMd);
            logger.info("\n--- End Audit ---\n");
        }

        // Phase 5: Post decision (skip entirely in self-review mode)
        if (inputs.self) {
            logger.info("Self-review complete. Results displayed above (not posted).");
        } else {
            const shouldPost = autoMode
                ? !!inputs.post
                : inputs.post
                    ? await confirm({
                        message: `Post ${audit.findings.length} inline comment(s) to ${scm.provider}?`,
                        default: true,
                    })
                    : await confirm({
                        message: `Post this review as ${audit.findings.length} inline comment(s) on ${scm.provider}?`,
                        default: false,
                    });

            if (shouldPost) {
                await this.postReview(scm, owner, repo, prNumber, audit, rawDiff);
            } else if (!autoMode) {
                logger.info(`Review not posted. Artifacts at: ${result.artifactsDir}`);
            } else {
                logger.info(auditMd);
            }
        }

        // Phase 6: Cleanup
        if (!inputs["keep-artifacts"]) {
            await this.multiAgent.cleanup(result.artifactsDir);
        } else {
            logger.info(`Artifacts kept at: ${result.artifactsDir}`);
        }
    }

    private async postReview(
        scm: SCMService,
        owner: string,
        repo: string,
        prNumber: number,
        audit: AuditResult,
        rawDiff: string,
    ): Promise<void> {
        if (audit.findings.length === 0) {
            const summary = this.multiAgent.findingParser.formatSummaryTable(audit, prNumber);
            await scm.postReviewComment(owner, repo, prNumber, summary);
            logger.info("Summary posted (no inline findings).");
            return;
        }

        // Line numbers already resolved from diff content by the parser
        const comments: InlineComment[] = audit.findings.map((f) => ({
            file: f.file,
            line: f.line,
            body: this.multiAgent.findingParser.formatCommentBody(f),
        }));

        const summary = this.multiAgent.findingParser.formatSummaryTable(audit, prNumber);

        logger.info(`\nPosting to ${scm.provider}: ${comments.length} inline + summary...`);
        try {
            await scm.postInlineReview(owner, repo, prNumber, summary, comments);
            logger.info("Review posted successfully.");
        } catch (e) {
            logger.error(`Inline review failed: ${(e as Error).message}`);
            logger.info("Falling back to single comment...");
            await scm.postReviewComment(owner, repo, prNumber, audit.rawMarkdown || summary);
            logger.info("Posted as single comment.");
        }
    }

    private async resolveTicketContext(ticket?: string): Promise<string | undefined> {
        if (!ticket) return undefined;
        if (ticket.includes("/") || ticket.endsWith(".md") || ticket.endsWith(".txt")) {
            try {
                return await readFile(ticket, "utf8");
            } catch {
                /* inline text */
            }
        }
        return ticket;
    }

    private async resolveTarget(
        target?: string,
    ): Promise<{ scm: SCMService; owner: string; repo: string; prNumber: number }> {
        if (target && isPullRequestUrl(target)) {
            const parsed = parsePullRequestUrl(target);
            if (!parsed) throw new Error(`Invalid PR URL: ${target}`);
            return {
                scm: this.scmFactory.get(parsed.provider),
                owner: parsed.owner,
                repo: parsed.repo,
                prNumber: parsed.prNumber,
            };
        }

        const scm = await this.scmFactory.detect();
        const { owner, repo } = await this.git.getOwnerAndRepo();

        if (target && /^\d+$/.test(target)) {
            return { scm, owner, repo, prNumber: parseInt(target, 10) };
        }

        const branch = target ?? (await this.git.getCurrentBranch());
        if (branch === "main" || branch === "master") {
            throw new Error("Cannot review main/master. Provide a PR number or URL.");
        }

        const prNumber = await scm.findPullRequestByBranch(owner, repo, branch);
        if (!prNumber) throw new Error(`No open PR for branch '${branch}'.`);
        return { scm, owner, repo, prNumber };
    }
}
