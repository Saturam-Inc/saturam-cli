import { mkdir, rm, writeFile } from "fs/promises";
import { getLogger } from "log4js";
import { join } from "path";
import { Service } from "typedi";
import { PullRequestInfo } from "../../integrations/scm/scm.model";
import {
    getAuditMessages,
    getExtractFindingsMessages,
    getReviewerMessages,
    getSecondAuditMessages,
} from "../../prompts/review.prompt";
import { WorkingDirectory } from "../../utils/working-directory";
import { LlmService } from "../llm-service";
import { AuditResult, FindingParser } from "./finding-parser.service";

const logger = getLogger("MultiAgentReview");

const TEMP_REVIEWER_A = 0.1;
const TEMP_REVIEWER_B = 0.4;
const TEMP_AUDITOR = 0.2;
const TEMP_SECOND_AUDITOR_A = 0.15;
const TEMP_SECOND_AUDITOR_B = 0.35;

const LARGE_PR_DIFF_LINES = 500;
const LARGE_PR_FILE_COUNT = 10;

export interface ReviewContext {
    prNumber: number;
    pr: PullRequestInfo;
    diff: string;
    ticketContext?: string;
}

export interface ReviewResult {
    audit: AuditResult;
    artifactsDir: string;
}

@Service()
export class MultiAgentReviewService {
    constructor(
        private readonly llm: LlmService,
        private readonly dir: WorkingDirectory,
        public readonly findingParser: FindingParser,
    ) {}

    public async run(context: ReviewContext): Promise<ReviewResult> {
        const artifactsDir = join(this.dir.repoRoot, ".context", "reviews");
        await mkdir(artifactsDir, { recursive: true });
        const base = `pr${context.prNumber}`;

        // --- Phase 1: Dual Independent Review ---
        logger.info("Phase 1: Running 2 reviewers in parallel...");
        const [rawReviewA, rawReviewB] = await Promise.all([
            this.runReviewer(context, "architecture", TEMP_REVIEWER_A),
            this.runReviewer(context, "data-flow", TEMP_REVIEWER_B),
        ]);

        await Promise.all([
            writeFile(join(artifactsDir, `${base}-reviewer-a.md`), rawReviewA, "utf8"),
            writeFile(join(artifactsDir, `${base}-reviewer-b.md`), rawReviewB, "utf8"),
        ]);

        const findingsA = this.findingParser.parseReviewerOutput(rawReviewA, context.diff);
        const findingsB = this.findingParser.parseReviewerOutput(rawReviewB, context.diff);
        logger.info(`  Reviewer A: ${findingsA.length} finding(s)`);
        logger.info(`  Reviewer B: ${findingsB.length} finding(s)`);

        // --- Phase 2: Audit ---
        logger.info("Phase 2: Auditor cross-validating findings...");
        const rawAudit = await this.runAuditor(context, rawReviewA, rawReviewB);
        await writeFile(join(artifactsDir, `${base}-audit.md`), rawAudit, "utf8");

        // --- Extract structured findings via LLM ---
        logger.info("Extracting structured findings...");
        const rawJson = await this.extractFindings(rawAudit, context.diff);
        await writeFile(join(artifactsDir, `${base}-findings.json`), rawJson, "utf8");

        const initialAudit = this.findingParser.parseJsonFindings(rawJson, rawAudit, context.diff);
        logger.info(`  Findings: ${initialAudit.findings.length}, Verdict: ${initialAudit.verdict}`);

        // --- Phase 3: Second Audit (large PRs only) ---
        const audit = this.shouldRunSecondAudit(context)
            ? await (async () => {
                logger.info("Phase 3: Large PR — running 2 second-round auditors...");
                const [rawSecondA, rawSecondB] = await Promise.all([
                    this.runSecondAuditor(context, rawAudit, TEMP_SECOND_AUDITOR_A),
                    this.runSecondAuditor(context, rawAudit, TEMP_SECOND_AUDITOR_B),
                ]);

                await Promise.all([
                    writeFile(join(artifactsDir, `${base}-audit-2a.md`), rawSecondA, "utf8"),
                    writeFile(join(artifactsDir, `${base}-audit-2b.md`), rawSecondB, "utf8"),
                ]);

                const corrected = this.findingParser.applySecondAuditCorrections(initialAudit, [rawSecondA, rawSecondB]);
                logger.info(`  After corrections: ${corrected.findings.length} finding(s)`);
                return corrected;
            })()
            : initialAudit;

        return { audit, artifactsDir };
    }

    public async cleanup(artifactsDir: string): Promise<void> {
        await rm(artifactsDir, { recursive: true, force: true });
    }

    private async runReviewer(
        context: ReviewContext,
        approach: "architecture" | "data-flow",
        temperature: number,
    ): Promise<string> {
        const { system, user } = getReviewerMessages({
            prNumber: context.prNumber,
            prTitle: context.pr.title,
            prBody: context.pr.body,
            diff: context.diff,
            ticketContext: context.ticketContext,
            approach,
        });
        return this.llm.prompt([system, user], undefined, { temperature });
    }

    private async runAuditor(context: ReviewContext, reviewA: string, reviewB: string): Promise<string> {
        const { system, user } = getAuditMessages({
            prNumber: context.prNumber,
            prTitle: context.pr.title,
            reviewA,
            reviewB,
            diff: context.diff,
        });
        return this.llm.prompt([system, user], undefined, { temperature: TEMP_AUDITOR });
    }

    private async extractFindings(audit: string, diff: string): Promise<string> {
        const { system, user } = getExtractFindingsMessages({ audit, diff });
        return this.llm.prompt([system, user], undefined, { temperature: 0 });
    }

    private async runSecondAuditor(context: ReviewContext, audit: string, temperature: number): Promise<string> {
        const { system, user } = getSecondAuditMessages({
            prNumber: context.prNumber,
            audit,
            diff: context.diff,
        });
        return this.llm.prompt([system, user], undefined, { temperature });
    }

    private shouldRunSecondAudit(context: ReviewContext): boolean {
        return context.diff.split("\n").length > LARGE_PR_DIFF_LINES || context.pr.changedFiles > LARGE_PR_FILE_COUNT;
    }
}
