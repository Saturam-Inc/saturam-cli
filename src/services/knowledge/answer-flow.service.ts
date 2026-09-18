import { getLogger } from "log4js";
import { Service } from "typedi";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../integrations/aws/services/bedrock-knowledge-base.service";
import { ConfigService } from "../config-service";
import { FollowUp, FollowUpGeneratorAgent } from "./agents/follow-up-generator.agent";
import { GeneralTechnicalAgent } from "./agents/general-technical.agent";
import { IntentClassifierAgent } from "./agents/intent-classifier.agent";
import { MentorAnswererAgent } from "./agents/mentor-answerer.agent";
import { ProjectCandidate, ProjectRouterAgent } from "./agents/project-router.agent";
import { ChatSession, ChatTurn, QuestionIntent, VERBATIM_TURN_WINDOW } from "./chat-session.model";
import { ConversationStoreProvider } from "./dynamodb-conversation-store";
import { ProjectRegistryService, RegistryProject } from "./project-registry.service";
import { SessionDigestService } from "./session-digest.service";

const logger = getLogger("AnswerFlow");

/** Chunks retrieved for the answer itself, once a project is settled. */
const ANSWER_RESULT_COUNT = 12;

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

export interface AnswerResult {
    answer: string;
    chunks: RetrievedChunk[];
    followUps: FollowUp[];
    intent: QuestionIntent;
    project?: RegistryProject;
    /** True when the user asked to rephrase instead of picking a project — nothing was answered. */
    cancelled: boolean;
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
    constructor(
        private readonly classifier: IntentClassifierAgent,
        private readonly router: ProjectRouterAgent,
        private readonly general: GeneralTechnicalAgent,
        private readonly mentor: MentorAnswererAgent,
        private readonly followUps: FollowUpGeneratorAgent,
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly digest: SessionDigestService,
        private readonly stores: ConversationStoreProvider,
        private readonly config: ConfigService,
    ) {}

    public async ask(question: string, chooser: ProjectChooser): Promise<AnswerResult> {
        const store = await this.stores.get();
        const sessionId = await this.config.getOrCreateChatSessionId();
        const session = await store.load(sessionId);
        const recentTurns = session.turns.slice(-VERBATIM_TURN_WINDOW);

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
            question: effectiveQuestion,
            session,
            recentTurns,
            chooser,
        });

        if (outcome.cancelled) {
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
        question: string;
        session: ChatSession;
        recentTurns: ChatTurn[];
        chooser: ProjectChooser;
    }): Promise<{ answer: string; chunks: RetrievedChunk[]; project?: RegistryProject; cancelled: boolean }> {
        const { classification, question, session, recentTurns } = params;

        if (classification === QuestionIntent.META) {
            return { answer: await this.describeCorpus(), chunks: [], cancelled: false };
        }

        if (classification === QuestionIntent.GENERAL_TECHNICAL) {
            const answer = await this.general.answer({ question, recentTurns, digest: session.digest });
            return { answer, chunks: [], cancelled: false };
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
        session: ChatSession;
        turn: ChatTurn;
    }): Promise<void> {
        const { store, session, turn } = params;
        await store.appendTurn(session.sessionId, turn);

        if (turn.resolvedProject && turn.resolvedProject !== session.activeProject) {
            await store.saveActiveProject(session.sessionId, turn.resolvedProject);
            session.activeProject = turn.resolvedProject;
        }

        const updated: ChatSession = { ...session, turns: [...session.turns, turn] };
        if (this.digest.shouldRefresh(updated)) {
            const refreshed = await this.digest.refresh(updated);
            if (refreshed) await store.saveDigest(session.sessionId, refreshed);
        }
    }
}
