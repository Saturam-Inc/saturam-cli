import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { ANSWER_AUDIT_SHAPE_HINT, getAnswerAuditMessages } from "../../../prompts/answer-audit.prompt";
import { GROUNDING_CHECK_SHAPE_HINT, getGroundingCheckMessages } from "../../../prompts/grounding-check.prompt";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("Verification");

/** Both checks are judgements about evidence, so neither gets any creative latitude. */
const TEMPERATURE = 0;

/** Rephrasings offered when the screen stops a question. */
const MAX_ALTERNATIVES = 4;

/** Flagging everything is the same as flagging nothing — a long list stops being read. */
const MAX_CLAIMS = 3;

export enum GroundingVerdict {
    SUFFICIENT = "sufficient",
    WRONG_SUBJECT = "wrong_subject",
    AMBIGUOUS = "ambiguous",
}

export const GroundingResultSchema = z.object({
    verdict: z.nativeEnum(GroundingVerdict),
    missing: z.string().default(""),
    alternativeQuestions: z.array(z.string()).default([]),
});

export type GroundingResult = z.infer<typeof GroundingResultSchema>;

export const AnswerAuditSchema = z.object({
    unsupportedClaims: z.array(z.string()).default([]),
});

export type AnswerAudit = z.infer<typeof AnswerAuditSchema>;

/**
 * Checks the answer against the documents, twice: once before it is written and once after.
 *
 * The two were separate agents and are one now because they are the same job at two moments, on
 * the same evidence, with the same dependency and the same conservative failure rule. Keeping
 * them apart implied they could be reasoned about independently, and they cannot — the screen is
 * biased to let things through precisely because the audit is behind it.
 *
 * They do catch different failures, which is why both still run:
 *
 * - `screen` sees retrieval but no answer. It catches the near-miss — a question about AWS Lambda
 *   pulling back documents on the Llama API — before the expensive answering call is spent.
 * - `audit` sees the finished answer. It catches what the screen structurally cannot: right
 *   subject, thin coverage, and the model quietly filling the thin parts with how such a system
 *   usually looks.
 */
@Service()
export class VerificationAgent {
    constructor(private readonly structured: StructuredOutputService) {}

    /**
     * Before answering: are these documents about the right subject at all?
     *
     * Deliberately biased toward passing. Thin coverage is the normal state of documentation and
     * the answering prompt is already required to name its own gaps, so this exists only for the
     * case where retrieval matched something that merely resembles the question's subject.
     */
    public async screen(params: { question: string; chunks: RetrievedChunk[] }): Promise<GroundingResult> {
        if (params.chunks.length === 0) {
            return {
                verdict: GroundingVerdict.WRONG_SUBJECT,
                missing: "Nothing in the knowledge base matched this question.",
                alternativeQuestions: [],
            };
        }

        try {
            const result = await this.structured.invoke({
                schema: GroundingResultSchema,
                name: "check_grounding",
                shapeHint: GROUNDING_CHECK_SHAPE_HINT,
                messages: getGroundingCheckMessages(params),
                options: { temperature: TEMPERATURE },
            });

            // Logged at info, not debug: how often this fires is the number that decides whether
            // the screen earns a call on every project question, or whether the audit behind it
            // is enough on its own.
            logger.info(`Grounding verdict: ${result.verdict}${result.missing ? ` — ${result.missing}` : ""}`);

            return {
                ...result,
                alternativeQuestions: result.alternativeQuestions
                    .map((q) => q.trim())
                    .filter(Boolean)
                    .slice(0, MAX_ALTERNATIVES),
            };
        } catch (err) {
            // Answering is better than refusing on a failed screen — the answering prompt still
            // carries its own "never invent" rules, and the audit still runs afterwards.
            logger.debug(`Grounding check failed (${(err as Error).message}) — answering anyway.`);
            return { verdict: GroundingVerdict.SUFFICIENT, missing: "", alternativeQuestions: [] };
        }
    }

    /**
     * After answering: does the answer claim anything about our systems that the documents do
     * not support?
     *
     * Findings are surfaced as a caveat under the answer rather than used to suppress it. A
     * mostly-correct answer with one flagged line is more useful than no answer, and suppression
     * would make a false alarm expensive.
     */
    public async audit(params: { question: string; answer: string; chunks: RetrievedChunk[] }): Promise<AnswerAudit> {
        // With nothing retrieved there is no document to check against, so every claim would read
        // as unsupported and the caveat would swamp the answer. The flow already refuses to answer
        // from an empty context, so this only guards direct callers.
        if (params.chunks.length === 0 || !params.answer.trim()) {
            return { unsupportedClaims: [] };
        }

        try {
            const result = await this.structured.invoke({
                schema: AnswerAuditSchema,
                name: "audit_answer",
                shapeHint: ANSWER_AUDIT_SHAPE_HINT,
                messages: getAnswerAuditMessages(params),
                options: { temperature: TEMPERATURE },
            });

            const claims = result.unsupportedClaims
                .map((claim) => claim.trim())
                .filter(Boolean)
                .slice(0, MAX_CLAIMS);

            if (claims.length > 0) {
                logger.debug(`Answer audit flagged ${claims.length} unsupported claim(s).`);
            }
            return { unsupportedClaims: claims };
        } catch (err) {
            // A failed audit must not cost the user their answer. Silence is the right failure
            // here: the alternative is warning about claims nobody actually checked.
            logger.debug(`Answer audit failed (${(err as Error).message}) — leaving the answer unannotated.`);
            return { unsupportedClaims: [] };
        }
    }
}
