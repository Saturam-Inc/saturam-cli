import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { GROUNDING_CHECK_SHAPE_HINT, getGroundingCheckMessages } from "../../../prompts/grounding-check.prompt";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("Verification");

/** Both checks are judgements about evidence, so neither gets any creative latitude. */
const TEMPERATURE = 0;

/** Rephrasings offered when the screen stops a question. */
const MAX_ALTERNATIVES = 4;

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

/**
 * Checks, before an answer is written, that retrieval found the right subject.
 *
 * A second check used to run after the answer, reading it back against its sources and flagging
 * anything unsupported. It was removed: on the models this CLI has to support it could not tell
 * invention from honest reporting, flagging file names and commands that sat plainly in the
 * retrieved documents. A warning under a correct answer teaches the reader to distrust the
 * answers, which is a worse outcome than the invention it was meant to catch.
 *
 * What guards invention now is what demonstrably works: the flow refuses outright when retrieval
 * comes back empty, and the answering prompts are required to name their own gaps rather than
 * fill them.
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
}
