import { getLogger } from "log4js";
import { Service } from "typedi";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../integrations/aws/services/bedrock-knowledge-base.service";
import { ConfigService } from "../config-service";
import { FollowUp, FollowUpGeneratorAgent } from "./agents/follow-up-generator.agent";
import { GeneralTechnicalAgent } from "./agents/general-technical.agent";
import { GroundingCheckAgent, GroundingVerdict } from "./agents/grounding-check.agent";
import { IntentClassifierAgent } from "./agents/intent-classifier.agent";
import { MentorAnswererAgent } from "./agents/mentor-answerer.agent";
import { ProjectCandidate, ProjectRouterAgent } from "./agents/project-router.agent";
import { CARRY_OVER_TURNS, ChatSession, ChatTurn, QuestionIntent, contextTurns } from "./chat-session.model";
import { SessionRef, describeOwner, getOwnerId, newSessionId } from "./session-identity";
import { ConversationStoreProvider } from "./dynamodb-conversation-store";
import { ProjectRegistryService, RegistryProject } from "./project-registry.service";
import { SessionDigestService } from "./session-digest.service";

const logger = getLogger("AnswerFlow");

/** Chunks retrieved for the answer itself, once a project is settled. */
const ANSWER_RESULT_COUNT = 12;

/** Previous sessions consulted when gathering carry-over context. */
const CARRY_OVER_SESSION_LOOKBACK = 3;

/** What the user picked when asked to disambiguate a project. */
export type ProjectChoice = { kind: "project"; slug: string } | { kind: "all" } | { kind: "rephrase" };

/**
 * How the flow asks the user to choose between projects. Implemented by the CLI with an
 * interactive picker, and by non-interactive callers by taking the top candidate. Keeping it an
 * interface is what lets the orchestrator stay free of terminal concerns, so the phase-2 frontend
 * can implement the same contract differently.
 */
export interface ProjectChooser {
    choose(question: string, candidates: ProjectCandidate[]): Promise<ProjectChoice>;
}

/**
 * Returned instead of an answer when the retrieved context does not support one. The questions
 * are put to the user as selectable options, and their reply becomes the next question.
 */
export interface ClarificationRequest {
    /** One sentence naming what is missing. */
    missing: string;
    questions: string[];
}

export interface AnswerResult {
    answer: string;
    chunks: RetrievedChunk[];
    followUps: FollowUp[];
    intent: QuestionIntent;
    project?: RegistryProject;
    /** True when the user asked to rephrase instead of picking a project — nothing was answered. */
    cancelled: boolean;
    /** Present when the flow needs more from the user before it can answer. */
    clarification?: ClarificationRequest;
}

/**
 * Orchestrates the answering flow: classify, route, retrieve, answer, suggest.
 *
 * Owns session state and the order of operations; every decision itself belongs to an agent. The
 * flow is a shallow decision tree with one interaction point, so it is wired with explicit control
 * flow rather than a graph framework — the same approach MultiAgentReviewService already uses.
 */
@Service()
export class AnswerFlowService {
    /** The conversation this process is in, once resolved. */
    private currentRef: SessionRef | undefined;
    /** Context read once per run from the owner's previous sessions. */
    private carried: { turns: ChatTurn[]; activeProject?: string } | undefined;
    /** Set by startNewSession, consumed by the next resolve. */
    private forcedSession: SessionRef | undefined;

    constructor(
        private readonly classifier: IntentClassifierAgent,
        private readonly router: ProjectRouterAgent,
        private readonly general: GeneralTechnicalAgent,
        private readonly grounding: GroundingCheckAgent,
        private readonly mentor: MentorAnswererAgent,
        private readonly followUps: FollowUpGeneratorAgent,
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly digest: SessionDigestService,
        private readonly stores: ConversationStoreProvider,
        private readonly config: ConfigService,
    ) {}

    public async ask(
        question: string,
        chooser: ProjectChooser,
        options?: { allowClarification?: boolean },
    ): Promise<AnswerResult> {
        const allowClarification = options?.allowClarification ?? true;
        const store = await this.stores.get();
        const { ref, session } = await this.resolveSession(store);
        const recentTurns = contextTurns(session);

        const classification = await this.classifier.classify({
            question,
            recentTurns,
            digest: session.digest,
        });
        // Pronouns resolved against the conversation, so retrieval searches for the real subject
        // rather than the literal words "and why does it do that".
        const effectiveQuestion = classification.resolvedQuestion.trim() || question;

        const outcome = await this.produceAnswer({
            classification: classification.intent,
            projectHints: classification.projectHints,
            crossProject: classification.crossProject,
            question: effectiveQuestion,
            session,
            sessionRef: ref,
            recentTurns,
            chooser,
            allowClarification,
        });

        if (outcome.cancelled) {
            return { ...outcome, intent: classification.intent, followUps: [] };
        }

        // A clarification is not an answer: nothing is recorded, so the user's reply is treated as
        // a fresh question rather than a follow-up to something that was never said.
        if (outcome.clarification) {
            return { ...outcome, intent: classification.intent, followUps: [] };
        }

        // Independent of each other and both need the finished answer — run together so the user
        // waits for one round trip rather than two.
        const [followUps, answerGist] = await Promise.all([
            this.followUps.suggest({
                question: effectiveQuestion,
                answer: outcome.answer,
                chunks: outcome.chunks,
                digest: session.digest,
                projectDisplayName: outcome.project?.displayName,
            }),
            this.mentor.summarize(effectiveQuestion, outcome.answer),
        ]);

        await this.recordTurn({
            store,
            ref,
            session,
            turn: {
                index: session.turns.length,
                question,
                answer: outcome.answer,
                answerGist,
                intent: classification.intent,
                resolvedProject: outcome.project?.slug,
                retrievedChunkIds: outcome.chunks.map((c) => c.location ?? "").filter(Boolean),
                createdAt: new Date().toISOString(),
            },
        });

        return { ...outcome, intent: classification.intent, followUps };
    }

    private async produceAnswer(params: {
        classification: QuestionIntent;
        projectHints: string[];
        crossProject: boolean;
        question: string;
        session: ChatSession;
        sessionRef: SessionRef;
        recentTurns: ChatTurn[];
        chooser: ProjectChooser;
        allowClarification: boolean;
    }): Promise<{
        answer: string;
        chunks: RetrievedChunk[];
        project?: RegistryProject;
        cancelled: boolean;
        clarification?: ClarificationRequest;
    }> {
        const { classification, question, session, recentTurns } = params;

        if (classification === QuestionIntent.META) {
            return { answer: await this.describeCorpus(), chunks: [], cancelled: false };
        }

        if (classification === QuestionIntent.SMALL_TALK) {
            return { answer: await this.greet(), chunks: [], cancelled: false };
        }

        if (classification === QuestionIntent.CONVERSATION) {
            return { answer: await this.recall(session, params.sessionRef), chunks: [], cancelled: false };
        }

        if (classification === QuestionIntent.GENERAL_TECHNICAL) {
            const answer = await this.general.answer({ question, recentTurns, digest: session.digest });
            return { answer, chunks: [], cancelled: false };
        }

        // A question spanning projects must not inherit the sticky project: narrowing it would
        // report on one project in language that sounds like it covered them all.
        if (params.crossProject) {
            const chunks = await this.retrieveForAnswer(question, undefined, []);
            const gate = await this.grounding.check({ question, chunks });
            if (this.shouldClarify(gate, params.allowClarification)) {
                return { answer: "", chunks, cancelled: false, clarification: this.toClarification(gate) };
            }
            const answer = await this.mentor.answer({ question, chunks, recentTurns, digest: session.digest });
            return { answer, chunks, cancelled: false };
        }

        const decision = await this.router.route({
            question,
            projectHints: params.projectHints,
            activeProject: session.activeProject,
        });

        let project: RegistryProject | undefined;
        if (decision.kind === "resolved") {
            project = decision.project;
        } else if (decision.kind === "ambiguous") {
            const choice = await params.chooser.choose(question, decision.candidates);
            if (choice.kind === "rephrase") {
                return { answer: "", chunks: [], cancelled: true };
            }
            if (choice.kind === "project") {
                project = decision.candidates.find((c) => c.project.slug === choice.slug)?.project;
            }
        }

        const chunks = await this.retrieveForAnswer(question, project, decision.probeChunks);

        const gate = await this.grounding.check({ question, chunks });
        if (this.shouldClarify(gate, params.allowClarification)) {
            return { answer: "", chunks, project, cancelled: false, clarification: this.toClarification(gate) };
        }

        const answer = await this.mentor.answer({
            question,
            chunks,
            projectDisplayName: project?.displayName,
            recentTurns,
            digest: session.digest,
        });

        return { answer, chunks, project, cancelled: false };
    }

    /**
     * Whether to stop and ask rather than answer. A failed verdict with no usable questions falls
     * through to answering instead of leaving the user at a dead end — the answer prompt's own
     * "never invent" and "name the gaps" rules then carry the weight.
     */
    private shouldClarify(
        gate: { verdict: GroundingVerdict; alternativeQuestions: string[] },
        allowClarification: boolean,
    ): boolean {
        // Never two clarifications in a row. Without this hard stop, each suggested rephrasing can
        // itself fail the gate and the user is walked through an endless chain of questions
        // without ever receiving an answer — worse than the wrong answer this gate exists to catch.
        if (!allowClarification) return false;
        return gate.verdict !== GroundingVerdict.SUFFICIENT && gate.alternativeQuestions.length > 0;
    }

    private toClarification(gate: { missing: string; alternativeQuestions: string[] }): ClarificationRequest {
        return {
            missing: gate.missing || "I could not find that in the documentation.",
            questions: gate.alternativeQuestions,
        };
    }

    /** Short greeting, answered from the registry with no model call. */
    private async greet(): Promise<string> {
        const { projects } = await this.registry.load();
        if (projects.length === 0) {
            return "Hello. No project documentation is indexed yet, so ask me a general engineering question and I'll help with that.";
        }
        const names = projects.map((p) => p.displayName).join(", ");
        return `Hello. I can help with ${names}, or with a general engineering question — what would you like to know?`;
    }

    /**
     * Retrieves the chunks the answer is built from. The router's probe was unfiltered and
     * deliberately shallow, so a resolved project earns its own filtered retrieval; an unresolved
     * one reuses the probe rather than paying for an identical second call.
     */
    private async retrieveForAnswer(
        question: string,
        project: RegistryProject | undefined,
        probeChunks: RetrievedChunk[],
    ): Promise<RetrievedChunk[]> {
        try {
            if (project) {
                return await this.knowledgeBase.retrieve(question, {
                    project: project.slug,
                    numberOfResults: ANSWER_RESULT_COUNT,
                });
            }
            if (probeChunks.length > 0) return probeChunks;
            return await this.knowledgeBase.retrieve(question, { numberOfResults: ANSWER_RESULT_COUNT });
        } catch (err) {
            logger.warn(`Retrieval failed: ${(err as Error).message}`);
            return probeChunks;
        }
    }

    /**
     * Resolves the session for this run.
     *
     * Every process gets its own session, so each terminal and each restart is a separate
     * conversation in the table. Continuity comes from context rather than from sharing an id:
     * the owner's most recent turns are read back and handed to the agents, which is what lets a
     * new terminal understand "so what tech stacks are used" as a continuation.
     */
    private async resolveSession(
        store: Awaited<ReturnType<ConversationStoreProvider["get"]>>,
    ): Promise<{ ref: SessionRef; session: ChatSession }> {
        const ownerId = getOwnerId();

        if (!this.currentRef) {
            // An explicitly requested new session starts clean: that is what the user asked for.
            const startingClean = this.forcedSession !== undefined;
            this.currentRef = this.forcedSession ?? { ownerId, sessionId: newSessionId() };
            this.forcedSession = undefined;
            // Carried context is read once per run: it is history, so it cannot change underneath us.
            this.carried = startingClean
                ? { turns: [] }
                : await this.loadCarryOver(store, ownerId, this.currentRef.sessionId);
            if (this.carried.turns.length > 0) {
                logger.debug(
                    `Carried ${this.carried.turns.length} turn(s) from earlier sessions for ${describeOwner(ownerId)}.`,
                );
            }
        }

        const session = await store.load(this.currentRef);
        return {
            ref: this.currentRef,
            session: {
                ...session,
                carriedTurns: this.carried?.turns ?? [],
                // Only seed the project while this session has said nothing of its own; after that
                // its own routing decisions take over.
                activeProject:
                    session.activeProject ?? (session.turns.length === 0 ? this.carried?.activeProject : undefined),
            },
        };
    }

    /** The owner's most recent turns, oldest first, drawn from their previous sessions. */
    private async loadCarryOver(
        store: Awaited<ReturnType<ConversationStoreProvider["get"]>>,
        ownerId: string,
        currentSessionId: string,
    ): Promise<{ turns: ChatTurn[]; activeProject?: string }> {
        const recent = (await store.findRecentSessionIds(ownerId, CARRY_OVER_SESSION_LOOKBACK)).filter(
            (id) => id !== currentSessionId,
        );

        const turns: ChatTurn[] = [];
        let activeProject: string | undefined;
        for (const sessionId of recent) {
            const previous = await store.load({ ownerId, sessionId });
            // Sessions arrive newest first, so each older block goes in front of what we have.
            turns.unshift(...previous.turns);
            activeProject ??= previous.activeProject;
            if (turns.length >= CARRY_OVER_TURNS) break;
        }

        return { turns: turns.slice(-CARRY_OVER_TURNS), activeProject };
    }

    /**
     * Recalls the conversation. When the current session is still empty — the usual case in a
     * fresh terminal after the last one went cold — it recalls the previous session instead,
     * which is what "what did we discuss last time?" actually means.
     */
    private async recall(session: ChatSession, ref: SessionRef): Promise<string> {
        // Carried turns count as "what we discussed": in a new terminal they are the only history
        // there is, and they are exactly what the user is asking to be reminded of. Say plainly
        // when nothing has been asked yet in this run, so the recap is not mistaken for this one.
        const carried = session.carriedTurns ?? [];
        const known = [...carried, ...session.turns];
        if (known.length > 0) {
            const recap = this.recapConversation({ ...session, turns: known });
            return session.turns.length === 0 && carried.length > 0
                ? `That was in an earlier conversation:\n\n${recap}`
                : recap;
        }

        const store = await this.stores.get();
        const recent = await store.findRecentSessionIds(ref.ownerId, 2);
        const previousId = recent.find((id) => id !== ref.sessionId);
        if (previousId) {
            const previous = await store.load({ ownerId: ref.ownerId, sessionId: previousId });
            if (previous.turns.length > 0) {
                return `That was in an earlier conversation:\n\n${this.recapConversation(previous)}`;
            }
        }
        return this.recapConversation(session);
    }

    /**
     * Answers "what was I asking about?" from session history, with no retrieval and no model
     * call. Running the normal pipeline here re-explains the topic in full, which is not what
     * someone asking to be reminded actually wants.
     */
    private recapConversation(session: ChatSession): string {
        if (session.turns.length === 0) {
            return "We haven't covered anything yet — this is the first question in this conversation.";
        }

        const recent = session.turns.slice(-5);
        const lines = recent.map((turn) => {
            const project = turn.resolvedProject ? ` [${turn.resolvedProject}]` : "";
            return `- "${turn.question}"${project} — ${turn.answerGist}`;
        });

        const older = session.turns.length - recent.length;
        const intro =
            older > 0
                ? `Here's the last ${recent.length} of ${session.turns.length} questions in this conversation:`
                : `Here's what we've covered so far:`;

        const parts = [intro, "", ...lines];
        if (session.digest?.summary) {
            parts.push("", `Earlier on: ${session.digest.summary}`);
        }
        return parts.join("\n");
    }

    /** Answers "what can you tell me about?" from the registry, with no model call. */
    private async describeCorpus(): Promise<string> {
        const { projects } = await this.registry.load();
        if (projects.length === 0) {
            return "No project documentation is indexed yet, so I can only help with general engineering questions for now.";
        }

        const lines = projects.map((p) => {
            const count = p.documentCount !== undefined ? ` — ${p.documentCount} document(s)` : "";
            const summary = p.summary ? `\n  ${p.summary}` : "";
            return `- **${p.displayName}**${count}${summary}`;
        });

        return [
            `I can answer questions about ${projects.length} indexed project${projects.length === 1 ? "" : "s"}:`,
            "",
            ...lines,
            "",
            "Ask about any of them, or ask a general engineering question and I'll answer it directly.",
        ].join("\n");
    }

    private async recordTurn(params: {
        store: Awaited<ReturnType<ConversationStoreProvider["get"]>>;
        ref: SessionRef;
        session: ChatSession;
        turn: ChatTurn;
    }): Promise<void> {
        const { store, ref, session, turn } = params;
        await store.appendTurn(ref, turn);

        if (turn.resolvedProject && turn.resolvedProject !== session.activeProject) {
            await store.saveActiveProject(ref, turn.resolvedProject);
            session.activeProject = turn.resolvedProject;
        }

        const updated: ChatSession = { ...session, turns: [...session.turns, turn] };
        if (this.digest.shouldRefresh(updated)) {
            const refreshed = await this.digest.refresh(updated);
            if (refreshed) await store.saveDigest(ref, refreshed);
        }
    }

    /** Starts a fresh conversation for the next question, ignoring whatever is in progress. */
    public startNewSession(): void {
        this.forcedSession = { ownerId: getOwnerId(), sessionId: newSessionId() };
        this.currentRef = undefined;
        this.carried = undefined;
    }
}
