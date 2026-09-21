import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { RETRIEVAL_PLAN_SHAPE_HINT, getRetrievalPlanMessages } from "../../../prompts/retrieval-plan.prompt";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("RetrievalPlanner");

/** Deterministic: the same change question should plan the same searches every time. */
const TEMPERATURE = 0;

/** More than this and the searches start returning each other's documents. */
const MAX_QUERIES = 4;

export const RetrievalPlanSchema = z.object({
    intent: z.string().default(""),
    queries: z.array(z.string()).default([]),
});

export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>;

/**
 * Decomposes a change-or-impact question into the handful of searches that actually reach the
 * answer: where the thing is configured, what triggers it, what depends on it, and whether a
 * runbook covers changing it.
 *
 * Single-shot retrieval is what made these questions look like a documentation gap. It is not
 * one — in the corpus this was built against, the change cookbook and the triggering-strategy
 * page were both indexed the whole time, and neither was ever returned, because the question's
 * wording sits nearer the pages that merely describe the schedule.
 */
@Service()
export class RetrievalPlannerAgent {
    constructor(private readonly structured: StructuredOutputService) {}

    public async plan(params: {
        question: string;
        projectDisplayName?: string;
        priorSubject?: string;
    }): Promise<RetrievalPlan> {
        try {
            const result = await this.structured.invoke({
                schema: RetrievalPlanSchema,
                name: "plan_retrieval",
                shapeHint: RETRIEVAL_PLAN_SHAPE_HINT,
                messages: getRetrievalPlanMessages(params),
                options: { temperature: TEMPERATURE },
            });

            const queries = this.dedupe(result.queries).slice(0, MAX_QUERIES);
            if (queries.length === 0) {
                logger.debug("Planner returned no usable queries — falling back to the original question.");
                return { intent: result.intent, queries: [params.question] };
            }

            logger.debug(`Planned ${queries.length} search(es): ${queries.join(" | ")}`);
            return { intent: result.intent, queries };
        } catch (err) {
            // Planning is an optimisation over searching the question itself, so its failure costs
            // retrieval quality, never the answer.
            logger.debug(`Retrieval planning failed (${(err as Error).message}) — searching the question as asked.`);
            return { intent: "", queries: [params.question] };
        }
    }

    /** Case-insensitive, so two queries differing only in capitalisation do not buy two searches. */
    private dedupe(queries: string[]): string[] {
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const query of queries) {
            const trimmed = query.trim();
            const key = trimmed.toLowerCase();
            if (!trimmed || seen.has(key)) continue;
            seen.add(key);
            unique.push(trimmed);
        }
        return unique;
    }
}
