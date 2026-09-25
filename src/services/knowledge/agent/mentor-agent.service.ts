import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { getMentorAgentMessages } from "../../../prompts/mentor-agent.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, SessionDigest } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";
import { KNOWLEDGE_TOOL_DEFINITIONS, KnowledgeToolExecutor, KnowledgeToolFactory, ToolCall } from "./knowledge-tools";

const logger = getLogger("MentorAgent");

/**
 * Enough give for the answer to read as writing rather than a form, without inviting invention.
 * One temperature, because there is now one call — the five the old flow tuned separately were
 * five prompts doing five jobs, and that is exactly what collapsed.
 */
const TEMPERATURE = 0.3;

/**
 * Ceiling on tool-calling rounds. Not a budget the agent is expected to spend — most questions
 * settle in one or two searches. It exists so a model that keeps re-searching instead of
 * answering cannot hang the terminal.
 */
const MAX_TOOL_ROUNDS = 6;

/** A model exposing LangChain's tool binding. SelfHostedChatModel is a bare `invoke`, and some
 *  Ollama builds are served by backends without tool support, so it is detected, not assumed. */
interface ToolCapableModel {
    bindTools: (tools: unknown[]) => { invoke(messages: BaseMessage[]): Promise<AIMessage> };
}

function supportsTools(model: unknown): model is ToolCapableModel {
    return typeof (model as ToolCapableModel)?.bindTools === "function";
}

export interface MentorAnswer {
    answer: string;
    /** Everything the agent retrieved while answering, in the order it found it. */
    chunks: RetrievedChunk[];
    /** The project the evidence settled on, if the chunks agree on one. */
    projectSlug?: string;
}

/**
 * Answers a question by letting the model drive: it searches, reads what came back, searches
 * again if it needs to, and writes when it has enough.
 *
 * This replaced a fixed pipeline — classify, route, retrieve once, screen, write — in which the
 * branch was chosen before any evidence existed and could not be revised afterwards. The loop is
 * the whole point: a search that misses is a thing the model can notice and fix, where the
 * pipeline could only refuse or hand the problem back to the user as a menu of rephrasings.
 */
@Service()
export class MentorAgentService {
    constructor(
        private readonly llm: LlmService,
        private readonly tools: KnowledgeToolFactory,
        private readonly registry: ProjectRegistryService,
    ) {}

    public async answer(params: {
        question: string;
        recentTurns: ChatTurn[];
        digest?: SessionDigest;
        /** Full history for `recall_conversation`, which may reach past the verbatim window. */
        history: ChatTurn[];
    }): Promise<MentorAnswer> {
        const model = await this.llm.getModel(undefined, { temperature: TEMPERATURE });
        const executor = this.tools.create(params.history);

        if (!supportsTools(model)) {
            logger.debug("Model does not support tool calling — answering from one pre-gathered search.");
            return this.answerWithoutTools(params, executor);
        }

        const bound = model.bindTools([...KNOWLEDGE_TOOL_DEFINITIONS]);
        const messages: BaseMessage[] = getMentorAgentMessages({
            question: params.question,
            recentTurns: params.recentTurns,
            digest: params.digest,
        });

        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
            const response = await bound.invoke(messages);
            const calls = this.toolCallsOf(response);

            if (calls.length === 0) {
                const answer = this.textOf(response).trim();
                // An empty final message with no tool calls means the model has nothing more to
                // say and never said anything. One more round would only repeat it.
                if (answer) {
                    logger.debug(`Answered after ${executor.searchCount} search(es), ${round + 1} round(s).`);
                    return this.finish(answer, executor);
                }
                break;
            }

            messages.push(response);
            // The calls in one round are independent by construction — the model issues them
            // together precisely because none depends on another's result — so they run at once.
            const results = await Promise.all(
                calls.map(
                    async (call) => new ToolMessage({ content: await executor.run(call), tool_call_id: call.id }),
                ),
            );
            messages.push(...results);
        }

        // Out of rounds, or nothing written. Ask once for the answer with no tools attached, so
        // the model has to write from what it already gathered rather than search again.
        logger.debug(`Tool loop did not settle in ${MAX_TOOL_ROUNDS} round(s) — asking for a final answer.`);
        const forced = await this.llm.prompt(
            [
                ...messages,
                new HumanMessage(
                    "Answer now, using only what you have already retrieved. If it does not cover the question, say exactly that.",
                ),
            ],
            undefined,
            { temperature: TEMPERATURE },
        );
        return this.finish(forced.trim(), executor);
    }

    /**
     * The path for providers with no tool calling. One search on the question, then one prompt —
     * deliberately the simplest thing that works rather than a second implementation of the loop.
     * A degraded path that is itself complicated is how the old branch tree started.
     */
    private async answerWithoutTools(
        params: { question: string; recentTurns: ChatTurn[]; digest?: SessionDigest },
        executor: KnowledgeToolExecutor,
    ): Promise<MentorAnswer> {
        const context = await executor.run({
            id: "fallback",
            name: "search_documentation",
            args: { query: params.question },
        });

        const answer = await this.llm.prompt(
            getMentorAgentMessages({
                question: params.question,
                recentTurns: params.recentTurns,
                digest: params.digest,
                preGatheredContext: context,
            }),
            undefined,
            { temperature: TEMPERATURE },
        );
        return this.finish(answer.trim(), executor);
    }

    private async finish(answer: string, executor: KnowledgeToolExecutor): Promise<MentorAnswer> {
        return { answer, chunks: executor.chunks, projectSlug: await this.dominantProject(executor.chunks) };
    }

    /**
     * The project the evidence agrees on, used only to label the answer in the interface. It is
     * read off the chunks rather than decided in advance — the old router's three tuned thresholds
     * were trying to predict this before the search that would have revealed it.
     */
    private async dominantProject(chunks: RetrievedChunk[]): Promise<string | undefined> {
        const counts = new Map<string, number>();
        for (const chunk of chunks) {
            const slug = chunk.metadata?.project;
            if (typeof slug !== "string" || !slug) continue;
            counts.set(slug, (counts.get(slug) ?? 0) + 1);
        }
        if (counts.size !== 1) return undefined;
        const [slug] = [...counts.keys()];
        return (await this.registry.getBySlug(slug)) ? slug : undefined;
    }

    private toolCallsOf(response: AIMessage): ToolCall[] {
        return (response.tool_calls ?? []).map((call, index) => ({
            id: call.id ?? `call_${index}`,
            name: call.name,
            args: (call.args ?? {}) as Record<string, unknown>,
        }));
    }

    private textOf(response: AIMessage): string {
        if (typeof response.content === "string") return response.content;
        if (!Array.isArray(response.content)) return "";
        return response.content
            .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
            .join("");
    }
}
