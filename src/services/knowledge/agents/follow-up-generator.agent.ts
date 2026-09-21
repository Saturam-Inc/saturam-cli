import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { FOLLOW_UP_SHAPE_HINT, getFollowUpMessages } from "../../../prompts/follow-up.prompt";
import { SessionDigest } from "../chat-session.model";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("FollowUpGenerator");

const TEMPERATURE = 0.5;
const MAX_FOLLOW_UPS = 4;

export const FollowUpsSchema = z.object({
    followUps: z.array(z.object({ question: z.string(), rationale: z.string().default("") })).default([]),
});

export interface FollowUp {
    question: string;
    rationale: string;
}

/**
 * Suggests what to ask next. Failure is non-fatal by design: the answer has already been produced
 * and printed, so a failed suggestion pass costs the user nothing but the suggestions themselves.
 */
@Service()
export class FollowUpGeneratorAgent {
    constructor(private readonly structured: StructuredOutputService) {}

    public async suggest(params: {
        question: string;
        answer: string;
        chunks: RetrievedChunk[];
        digest?: SessionDigest;
        projectDisplayName?: string;
    }): Promise<FollowUp[]> {
        try {
            const result = await this.structured.invoke({
                schema: FollowUpsSchema,
                name: "suggest_follow_ups",
                shapeHint: FOLLOW_UP_SHAPE_HINT,
                messages: getFollowUpMessages(params),
                options: { temperature: TEMPERATURE },
            });

            return result.followUps
                .map((f) => ({ question: f.question.trim(), rationale: f.rationale }))
                .filter((f) => f.question.length > 0)
                .slice(0, MAX_FOLLOW_UPS);
        } catch (err) {
            logger.debug(`Follow-up generation failed: ${(err as Error).message}`);
            return [];
        }
    }
}
