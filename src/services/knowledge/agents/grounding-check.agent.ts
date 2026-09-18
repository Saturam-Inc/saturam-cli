import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { GROUNDING_CHECK_SHAPE_HINT, getGroundingCheckMessages } from "../../../prompts/grounding-check.prompt";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("GroundingCheck");

const TEMPERATURE = 0;
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
 * Gates the answer on whether the retrieved context actually supports one.
 *
 * Retrieval never returns nothing — it returns its nearest matches regardless of how far off they
 * are. This agent is what stops a near-miss ("Lambda" matching documents about "Llama") from
 * becoming a confident wrong answer, and turns it into a clarifying question instead.
 */
@Service()
export class GroundingCheckAgent {
    constructor(private readonly structured: StructuredOutputService) {}

    public async check(params: { question: string; chunks: RetrievedChunk[] }): Promise<GroundingResult> {
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

            if (result.verdict !== GroundingVerdict.SUFFICIENT) {
                logger.debug(`Grounding verdict: ${result.verdict} — ${result.missing}`);
            }

            return {
                ...result,
                alternativeQuestions: result.alternativeQuestions
                    .map((q) => q.trim())
                    .filter(Boolean)
                    .slice(0, MAX_ALTERNATIVES),
            };
        } catch (err) {
            // Answering is better than refusing on a failed gate — the answer prompt still carries
            // its own "never invent" and "name the gaps" rules.
            logger.debug(`Grounding check failed (${(err as Error).message}) — answering anyway.`);
            return { verdict: GroundingVerdict.SUFFICIENT, missing: "", alternativeQuestions: [] };
        }
    }
}
