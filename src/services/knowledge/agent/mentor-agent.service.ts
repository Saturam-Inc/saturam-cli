import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { getMentorAgentMessages } from "../../../prompts/mentor-agent.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, SessionDigest } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";
import { findUnsupportedIdentifiers } from "../unsupported-identifiers";
import {
    Finding,
    KNOWLEDGE_TOOL_DEFINITIONS,
    KnowledgeToolExecutor,
    KnowledgeToolFactory,
    ToolCall,
} from "./knowledge-tools";

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
 * answering cannot hang the terminal. Raised from six when reading and browsing arrived: a
 * question about code is often search, browse, read, read, answer, and six left no room for a
 * second search when the first one missed.
 */
export const MAX_TOOL_ROUNDS = 10;

/**
 * The ceiling once the agent has declared, through begin_change_plan or begin_walkthrough, that
 * it is planning a change or explaining a mechanism end to end. Both are locate, trace, read the
 * files, check the documents, then write — more rounds than a plain question needs, and worth
 * them, because a plan that stopped tracing early misses what the change breaks, and a walkthrough
 * that stopped early explains the first half of the path.
 */
export const MAX_PLAN_TOOL_ROUNDS = 16;

/**
 * What the agent is told when its draft names something nothing it retrieved supports. It still
 * has its tools at this point, which the flow's revision step does not, so it can look the name up
 * rather than have a reviser guess whether to keep it.
 */
function verificationRequest(names: string[]): string {
    const list = names.map((name) => `\`${name}\``).join(", ");
    return `Before this goes to the reader: nothing you retrieved supports ${names.length === 1 ? "this name" : "these names"}: ${list}. For each one, verify it with a tool (search for it, find_symbol, open the file it should be in) or take it out of the answer. Then give the final answer in full, exactly as you would have sent it.`;
}

function renderFinding(note: Finding): string {
    const missing = note.missing ? ` · missing: ${note.missing}` : "";
    const next = note.next ? ` · next: ${note.next}` : "";
    return `- ${note.established}${missing}${next}`;
}

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
    /**
     * Names the agent saw by listing or reading rather than in a retrieved passage — a path from
     * a directory listing, a document it read whole. The identifier guard counts them as support.
     */
    knownIdentifiers: string[];
    /** The change the agent declared it was planning, when the question asked for one. */
    planGoal?: string;
    /** The mechanism the agent declared it was explaining end to end, when the question asked for one. */
    walkthroughSubject?: string;
    /** The agent's working notes, for replays and the eval; nothing downstream depends on them. */
    findings: Finding[];
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
        /** Leading turns of recentTurns that came from earlier sessions; see getMentorAgentMessages. */
        carriedTurns?: number;
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
            carriedTurns: params.carriedTurns,
        });

        // Re-read each round: begin_change_plan or begin_walkthrough, called mid-loop, widens the budget from then on.
        const limit = () => (executor.deepDive ? MAX_PLAN_TOOL_ROUNDS : MAX_TOOL_ROUNDS);
        let verified = false;
        for (let round = 0; round < limit(); round += 1) {
            const response = await bound.invoke(messages);
            const calls = this.toolCallsOf(response);

            if (calls.length === 0) {
                const answer = this.textOf(response).trim();
                // An empty final message with no tool calls means the model has nothing more to
                // say and never said anything. One more round would only repeat it.
                if (answer) {
                    // One chance to check its own claims with the tools still attached, before the
                    // flow's guard revises blind. Only the names the evidence does not hold go back.
                    if (!verified && round + 1 < limit()) {
                        const unsupported = this.unsupportedIn(answer, executor, params.recentTurns);
                        if (unsupported.length > 0) {
                            verified = true;
                            logger.debug(
                                `Draft named ${unsupported.length} unsupported identifier(s) (${unsupported.join(", ")}) — one verification round.`,
                            );
                            messages.push(response, new HumanMessage(verificationRequest(unsupported)));
                            continue;
                        }
                    }
                    logger.debug(
                        `Answered after ${executor.searchCount} search(es), ${executor.readCount} read(s), ${round + 1} round(s).`,
                    );
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
        logger.debug(`Tool loop did not settle in ${limit()} round(s) — asking for a final answer.`);
        // The notes are what the agent itself said it had established; they are the best summary of
        // a long investigation that ran out of rounds.
        const notes =
            executor.findings.length > 0
                ? `\n\nYour notes so far:\n${executor.findings.map(renderFinding).join("\n")}`
                : "";
        const forced = await this.llm.prompt(
            [
                ...messages,
                new HumanMessage(
                    `Answer now, using only what you have already retrieved. If it does not cover the question, say you do not have that information and who they could ask instead.${notes}`,
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
        params: { question: string; recentTurns: ChatTurn[]; digest?: SessionDigest; carriedTurns?: number },
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
                carriedTurns: params.carriedTurns,
                preGatheredContext: context,
            }),
            undefined,
            { temperature: TEMPERATURE },
        );
        return this.finish(answer.trim(), executor);
    }

    private async finish(answer: string, executor: KnowledgeToolExecutor): Promise<MentorAnswer> {
        return {
            answer,
            chunks: executor.chunks,
            projectSlug: await this.dominantProject(executor.chunks),
            knownIdentifiers: executor.knownIdentifiers,
            planGoal: executor.changePlan?.goal,
            walkthroughSubject: executor.walkthrough?.subject,
            findings: executor.findings,
        };
    }

    /** The same check the flow runs afterwards, so what the agent is asked to verify is exactly what would be revised. */
    private unsupportedIn(answer: string, executor: KnowledgeToolExecutor, recentTurns: ChatTurn[]): string[] {
        const known = executor.knownIdentifiers;
        if (executor.chunks.length === 0 && known.length === 0) return [];
        const sources = executor.chunks.map((chunk) => chunk.content).join("\n");
        return findUnsupportedIdentifiers(
            answer,
            sources,
            recentTurns.map((turn) => turn.answer),
            known,
        );
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
