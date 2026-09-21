import { getLogger } from "log4js";
import { Service } from "typedi";
import { RetrievedChunk } from "../../integrations/aws/services/bedrock-knowledge-base.service";
import { AnswerWriterAgent } from "./agents/answer-writer.agent";
import { FollowUp, FollowUpGeneratorAgent } from "./agents/follow-up-generator.agent";
import { MentorAgentService } from "./agent/mentor-agent.service";
import { CARRY_OVER_TURNS, ChatSession, ChatTurn, SessionDigest, contextTurns } from "./chat-session.model";
import { redactSecrets } from "./redact-secrets";
import { findUnsupportedIdentifiers } from "./unsupported-identifiers";
import { SessionRef, describeOwner, getOwnerId, newSessionId } from "./session-identity";
import { ConversationStoreProvider } from "./dynamodb-conversation-store";
import { ProjectRegistryService, RegistryProject } from "./project-registry.service";
import { SessionDigestService } from "./session-digest.service";

const logger = getLogger("AnswerFlow");

/** Previous sessions consulted when gathering carry-over context. */
const CARRY_OVER_SESSION_LOOKBACK = 3;

export interface AnswerResult {
    answer: string;
    /** Everything the agent retrieved while answering — the interface lists these as sources. */
    chunks: RetrievedChunk[];
    followUps: FollowUp[];
    /** Set when the retrieved evidence all came from one indexed project. */
    project?: RegistryProject;
}

/** A digest with nothing summarised yet, for a goal recorded before the first refresh. */
function emptyDigest(): SessionDigest {
    return { summary: "", projectsDiscussed: [], jargonDefined: [], questionsAsked: [], coversUpToIndex: 0 };
}

/**
 * Owns conversation state and the order of operations around an answer. It does not decide
 * anything about the answer itself.
 *
 * It used to. An intent classifier chose one of nine branches before anything had been retrieved,
 * and each branch assembled its own reply — some from a model, several from string templates in
 * this file. Every question the classifier had not anticipated landed in the nearest branch and
 * got that branch's fixed response, which is how two differently-worded questions produced the
 * same canned paragraph.
 *
 * Now there is one path: hand the question to the agent, let it search until it can answer, then
 * do the three things that genuinely belong in code — check the answer names nothing the sources
 * do not, redact anything shaped like a credential, and write the turn down.
 */
@Service()
export class AnswerFlowService {
    /** The conversation this process is in, once resolved. */
    private currentRef: SessionRef | undefined;
    /** Context read once per run from the owner's previous sessions. */
    private carried: { turns: ChatTurn[]; activeProject?: string; learnerGoal?: string } | undefined;
    /** Set by startNewSession, consumed by the next resolve. */
    private forcedSession: SessionRef | undefined;

    constructor(
        private readonly mentor: MentorAgentService,
        private readonly writer: AnswerWriterAgent,
        private readonly followUps: FollowUpGeneratorAgent,
        private readonly registry: ProjectRegistryService,
        private readonly digest: SessionDigestService,
        private readonly stores: ConversationStoreProvider,
    ) {}

    public async ask(question: string): Promise<AnswerResult> {
        const store = await this.stores.get();
        const { ref, session } = await this.resolveSession(store);
        const recentTurns = contextTurns(session);
        const history = [...(session.carriedTurns ?? []), ...session.turns];

        const produced = await this.mentor.answer({
            question,
            recentTurns,
            digest: session.digest,
            history,
        });

        const project = produced.projectSlug ? await this.registry.getBySlug(produced.projectSlug) : undefined;

        // Two guards on anything a model wrote, both silent. Identifiers the sources never mention
        // are taken back by a single revision; anything shaped like a credential is redacted. The
        // reader sees the corrected answer, never a warning about it.
        const answer = this.withSecretsRedacted(
            await this.withUnsupportedIdentifiersRevised(question, produced.answer, produced.chunks, recentTurns),
        );

        const [followUps, answerGist] = await Promise.all([
            this.followUps.suggest({
                question,
                answer,
                chunks: produced.chunks,
                digest: session.digest,
                projectDisplayName: project?.displayName,
            }),
            this.writer.summarize(question, answer),
        ]);

        await this.recordTurn({
            store,
            ref,
            session,
            turn: {
                index: session.turns.length,
                question,
                answer,
                answerGist,
                resolvedProject: project?.slug,
                retrievedChunkIds: produced.chunks.map((chunk) => chunk.location ?? "").filter(Boolean),
                createdAt: new Date().toISOString(),
            },
        });

        return { answer, chunks: produced.chunks, followUps, project };
    }

    /**
     * Records what the learner is here to do, so the agent can pitch its answers to it. Extracted
     * by the digest from what they actually said, rather than asked for up front by a fixed menu.
     */
    public async setLearnerGoal(goal: string): Promise<void> {
        const trimmed = goal.trim();
        if (!trimmed) return;
        const store = await this.stores.get();
        const { ref, session } = await this.resolveSession(store);
        await store.saveDigest(ref, { ...(session.digest ?? emptyDigest()), learnerGoal: trimmed });
        logger.debug(`Learner goal: ${trimmed}`);
    }

    /**
     * Takes back any file, path, script or table the answer named that appears in neither the
     * sources nor the earlier conversation. A string check, not a judgement, so it does not
     * suffer the false alarms a model-judged audit did on exactly this task — and the correction
     * is applied to the answer rather than announced under it.
     */
    private async withUnsupportedIdentifiersRevised(
        question: string,
        answer: string,
        chunks: RetrievedChunk[],
        recentTurns: ChatTurn[],
    ): Promise<string> {
        if (chunks.length === 0) return answer;
        const sources = chunks.map((chunk) => chunk.content).join("\n");
        const unsupported = findUnsupportedIdentifiers(
            answer,
            sources,
            recentTurns.map((turn) => turn.answer),
        );
        if (unsupported.length === 0) return answer;

        logger.debug(
            `Answer named ${unsupported.length} identifier(s) absent from the sources (${unsupported.join(", ")}) — revising once.`,
        );
        try {
            const revised = await this.writer.revise({ question, answer, unsupported });
            return revised.trim() || answer;
        } catch (err) {
            logger.debug(`Revision failed (${(err as Error).message}) — keeping the original answer.`);
            return answer;
        }
    }

    private withSecretsRedacted(answer: string): string {
        const { text, redacted } = redactSecrets(answer);
        if (redacted > 0) logger.warn(`Redacted ${redacted} credential-shaped value(s) from an answer.`);
        return text;
    }

    /**
     * Resolves the session for this run.
     *
     * Every process gets its own session, so each terminal and each restart is a separate
     * conversation in the table. Continuity comes from context rather than from sharing an id:
     * the owner's most recent turns are read back and handed to the agent, which is what lets a
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
                // A goal from an earlier session holds until the learner states a new one.
                digest:
                    session.digest?.learnerGoal || !this.carried?.learnerGoal
                        ? session.digest
                        : { ...(session.digest ?? emptyDigest()), learnerGoal: this.carried.learnerGoal },
                // Only seed the project while this session has said nothing of its own; after that
                // its own turns take over.
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
    ): Promise<{ turns: ChatTurn[]; activeProject?: string; learnerGoal?: string }> {
        const recent = (await store.findRecentSessionIds(ownerId, CARRY_OVER_SESSION_LOOKBACK)).filter(
            (id) => id !== currentSessionId,
        );

        const turns: ChatTurn[] = [];
        let activeProject: string | undefined;
        let learnerGoal: string | undefined;
        for (const sessionId of recent) {
            const previous = await store.load({ ownerId, sessionId });
            // Sessions arrive newest first, so each older block goes in front of what we have.
            turns.unshift(...previous.turns);
            activeProject ??= previous.activeProject;
            learnerGoal ??= previous.digest?.learnerGoal;
            if (turns.length >= CARRY_OVER_TURNS) break;
        }

        return { turns: turns.slice(-CARRY_OVER_TURNS), activeProject, learnerGoal };
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
