import { Service } from "typedi";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../integrations/aws/services/bedrock-knowledge-base.service";
import { getKnowledgeBaseChatMessages } from "../../prompts/knowledge-base-chat.prompt";
import { LlmService } from "../llm-service";

/**
 * Owns Bedrock Knowledge Base retrieval and RAG chat (retrieve → prompt build → LLM call),
 * so commands stay thin — on `main` no command calls LlmService directly, and OnboardCommand's
 * `--chat`/`--knowledge-base` flows should follow the same pattern instead of building the
 * pipeline inline.
 */
@Service()
export class KnowledgeBaseChatService {
    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly llmService: LlmService,
    ) {}

    /** Retrieve-only: the ranked chunks for a question, with no LLM generation. */
    public async search(question: string, options?: { project?: string }): Promise<RetrievedChunk[]> {
        return options?.project
            ? this.knowledgeBase.retrieve(question, { project: options.project })
            : this.knowledgeBase.retrieve(question);
    }

    /** Full RAG: retrieves context, then asks the configured LLM to answer grounded in it. */
    public async ask(
        question: string,
        options?: { project?: string },
    ): Promise<{ answer: string; chunks: RetrievedChunk[] }> {
        const chunks = await this.search(question, options);
        const { system, user } = getKnowledgeBaseChatMessages({ question, chunks, project: options?.project });
        const answer = await this.llmService.prompt([system, user]);
        return { answer, chunks };
    }
}
