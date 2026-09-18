import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { INTENT_CLASSIFIER_SHAPE_HINT, getIntentClassifierMessages } from "../../../prompts/intent-classifier.prompt";
import { ChatTurn, QuestionIntent, SessionDigest } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("IntentClassifier");

/** Deterministic: the same question should route the same way every time. */
const TEMPERATURE = 0;

export const IntentClassificationSchema = z.object({
    intent: z.nativeEnum(QuestionIntent),
    projectHints: z.array(z.string()).default([]),
    /**
     * True when the question asks across projects rather than about one ("do any of our projects
     * use Lambda?"). Without this the sticky project silently narrows the search to whatever was
     * discussed last, and the answer reports on one project while sounding like it covered all.
     */
    crossProject: z.boolean().default(false),
    /** The question with pronouns and elisions resolved against the conversation. */
    resolvedQuestion: z.string(),
    reasoning: z.string().default(""),
});

export type IntentClassification = z.infer<typeof IntentClassificationSchema>;

/**
 * Routes a question to general-knowledge or project-knowledge answering.
 *
 * There is deliberately no "follow-up" intent. A follow-up is not a peer of the other two — it is
 * still either general or project-scoped, and what makes it a follow-up is that its subject comes
 * from the previous turn. That is a context problem, solved by `resolvedQuestion`, not a routing one.
 */
@Service()
export class IntentClassifierAgent {
    constructor(
        private readonly structured: StructuredOutputService,
        private readonly registry: ProjectRegistryService,
    ) {}

    public async classify(params: {
        question: string;
        recentTurns: ChatTurn[];
        digest?: SessionDigest;
    }): Promise<IntentClassification> {
        const projectCatalogue = await this.registry.describeForPrompt();
        const messages = getIntentClassifierMessages({ ...params, projectCatalogue });

        try {
            const result = await this.structured.invoke({
                schema: IntentClassificationSchema,
                name: "classify_intent",
                shapeHint: INTENT_CLASSIFIER_SHAPE_HINT,
                messages,
                options: { temperature: TEMPERATURE },
            });
            logger.debug(`Intent: ${result.intent} (hints: ${result.projectHints.join(", ") || "none"})`);
            return result;
        } catch (err) {
            // A classification failure should degrade, not end the conversation. Project knowledge
            // is the safer default: it retrieves first and can still answer a general question,
            // whereas the general path would silently skip our documentation entirely.
            logger.warn(`Intent classification failed (${(err as Error).message}) — defaulting to project knowledge.`);
            return {
                intent: QuestionIntent.PROJECT_KNOWLEDGE,
                projectHints: [],
                crossProject: false,
                resolvedQuestion: params.question,
                reasoning: "classification failed",
            };
        }
    }
}
