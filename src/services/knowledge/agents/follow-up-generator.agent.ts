import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import {
    FOLLOW_UP_SHAPE_HINT,
    FollowUpDocument,
    documentKey,
    followUpDocuments,
    getFollowUpMessages,
} from "../../../prompts/follow-up.prompt";
import { SessionDigest } from "../chat-session.model";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("FollowUpGenerator");

/** Lower than it was: entries are drawn from listed documents now, and latitude here was invention. */
const TEMPERATURE = 0.3;
const MAX_FOLLOW_UPS = 3;
/** Knowledge-base hits examined per entry when confirming it can be answered. */
const CHECK_RESULT_COUNT = 5;

export const FollowUpsSchema = z.object({
    followUps: z
        .array(
            z.object({
                question: z.string(),
                /** The listed document the entry is drawn from; see getFollowUpMessages. */
                sourceIndex: z.number().int().optional(),
                rationale: z.string().default(""),
            }),
        )
        .default([]),
});

export interface FollowUp {
    question: string;
    rationale: string;
}

/**
 * Suggests what to ask next, and offers only what the knowledge base can answer.
 *
 * Two checks run in code on what the model proposed, because asking the prompt for grounded
 * entries was not enough: it kept offering questions that sounded like the documents and that
 * nothing indexed could answer. First, every entry must cite one of the documents the answer
 * retrieved, by number; one that cites nothing, or a number not on the list, is dropped. Second,
 * each survivor is run against the knowledge base and kept only when its best matches include a
 * document this answer drew on. An answer that retrieved nothing offers no follow-ups at all —
 * there is nothing to draw them from.
 *
 * Failure is non-fatal by design: the answer has already been produced and printed, so a failed
 * suggestion pass costs the user nothing but the suggestions themselves.
 */
@Service()
export class FollowUpGeneratorAgent {
    constructor(
        private readonly structured: StructuredOutputService,
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
    ) {}

    public async suggest(params: {
        question: string;
        answer: string;
        chunks: RetrievedChunk[];
        digest?: SessionDigest;
        projectDisplayName?: string;
        /** Narrows the answerability check to the project the answer came from, when it came from one. */
        projectSlug?: string;
    }): Promise<FollowUp[]> {
        const documents = followUpDocuments(params.chunks);
        if (documents.length === 0) {
            logger.debug("Nothing was retrieved for this answer, so there is nothing to draw follow-ups from.");
            return [];
        }

        try {
            const result = await this.structured.invoke({
                schema: FollowUpsSchema,
                name: "suggest_follow_ups",
                shapeHint: FOLLOW_UP_SHAPE_HINT,
                messages: getFollowUpMessages(params),
                options: { temperature: TEMPERATURE },
            });

            const cited = result.followUps
                .map((followUp) => ({ ...followUp, question: followUp.question.trim() }))
                .filter((followUp) => followUp.question.length > 0 && this.citesListedDocument(followUp, documents))
                .slice(0, MAX_FOLLOW_UPS);

            const answerable = await Promise.all(
                cited.map((followUp) => this.knowledgeBaseAnswers(followUp.question, documents, params.projectSlug)),
            );
            return cited
                .filter((_, index) => answerable[index])
                .map(({ question, rationale }) => ({ question, rationale }));
        } catch (err) {
            logger.debug(`Follow-up generation failed: ${(err as Error).message}`);
            return [];
        }
    }

    private citesListedDocument(
        followUp: { question: string; sourceIndex?: number },
        documents: FollowUpDocument[],
    ): boolean {
        const index = followUp.sourceIndex;
        const listed = index !== undefined && Number.isInteger(index) && index >= 1 && index <= documents.length;
        if (!listed) {
            const cited = index === undefined ? "no document" : `document ${index}, which is not listed`;
            logger.debug(`Dropped "${followUp.question}": it cites ${cited}.`);
        }
        return listed;
    }

    /**
     * Whether the knowledge base's best matches for the entry include a document this answer
     * drew on. A string check against retrieval results rather than a judgement, like the
     * unsupported-identifier guard on the answer itself. Fails open: the citation check has
     * already applied, and dropping every entry over a transient error would be the larger loss.
     */
    private async knowledgeBaseAnswers(
        question: string,
        documents: FollowUpDocument[],
        projectSlug?: string,
    ): Promise<boolean> {
        let hits: RetrievedChunk[];
        try {
            hits = await this.knowledgeBase.retrieve(question, {
                numberOfResults: CHECK_RESULT_COUNT,
                project: projectSlug,
            });
        } catch (err) {
            logger.debug(
                `Could not check "${question}" against the knowledge base (${(err as Error).message}) — keeping it.`,
            );
            return true;
        }

        const known = new Set(documents.map((document) => document.key));
        const answerable = hits.some((hit) => known.has(documentKey(hit)));
        if (!answerable) {
            logger.debug(`Dropped "${question}": its best matches are not among the documents this answer drew on.`);
        }
        return answerable;
    }
}
