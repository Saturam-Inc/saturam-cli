import { getLogger } from "log4js";
import { Service } from "typedi";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../integrations/aws/services/bedrock-knowledge-base.service";
import { ConfigService } from "../config-service";
import { AnswerWriterAgent } from "./agents/answer-writer.agent";
import { RetrievalPlannerAgent } from "./agents/retrieval-planner.agent";
import { FollowUp, FollowUpGeneratorAgent } from "./agents/follow-up-generator.agent";
import { IntentClassifierAgent } from "./agents/intent-classifier.agent";
import { QuizAgent, QuizQuestion } from "./agents/quiz.agent";
import { GroundingVerdict, VerificationAgent } from "./agents/verification.agent";
import { ProjectCandidate, ProjectRouterAgent } from "./agents/project-router.agent";
import {
    CARRY_OVER_TURNS,
    ChatSession,
    ChatTurn,
    LearnerStage,
    QUIZ_MENU_TEXT,
    QUIZ_OFFER_INTERVAL,
    QuestionIntent,
    SessionDigest,
    contextTurns,
    deriveStage,
} from "./chat-session.model";
import { redactSecrets } from "./redact-secrets";
import { findUnsupportedIdentifiers } from "./unsupported-identifiers";
import { SessionRef, describeOwner, getOwnerId, newSessionId } from "./session-identity";
import { ConversationStoreProvider } from "./dynamodb-conversation-store";
import { ProjectRegistryService, RegistryProject } from "./project-registry.service";
import { SessionDigestService } from "./session-digest.service";

const logger = getLogger("AnswerFlow");

/** Chunks retrieved for the answer itself, once a project is settled. */
const ANSWER_RESULT_COUNT = 12;

/**
 * Chunks per sub-query on the change path. Lower than ANSWER_RESULT_COUNT because several
 * searches run: the point is breadth across angles, not depth on any one of them.
 */
const PLANNED_RESULT_COUNT = 6;

/** Ceiling on the merged set, so four searches cannot bury the answering prompt. */
const MERGED_RESULT_CAP = 14;

/**
 * Chunks pulled when checking whether a general question also has a house answer. Deliberately
 * small: this is a "do we have anything on this at all" probe, not the basis of the answer.
 */
const GENERAL_PROBE_RESULT_COUNT = 6;

/** Projects offered as "tell me about X" after a greeting or a corpus question. */
const ASSEMBLED_FOLLOW_UP_COUNT = 4;

/** Previous sessions consulted when gathering carry-over context. */
const CARRY_OVER_SESSION_LOOKBACK = 3;

/**
 * How well the retrieved documentation backed the answer. The CLI does not branch on this yet;
 * it exists so "we could not answer that" is a first-class outcome the flow reports, rather than
 * something a caller has to infer from the prose.
 */
export enum AnswerCoverage {
    /** Answered from retrieved documentation. */
    DOCUMENTED = "documented",
    /** A general answer that our own documentation also had something to say about. */
    BLENDED = "blended",
    /** Nothing usable was retrieved, so the answer says so instead of guessing. */
    NOT_DOCUMENTED = "not_documented",
    /** Retrieval did not apply: general knowledge, small talk, recall, or a corpus description. */
    NOT_APPLICABLE = "not_applicable",
}

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

/**
 * Returned instead of an answer when the mentor wants to know why the learner is here first.
 * Assembled in code, not generated: the goals a new engineer arrives with are few and universal,
 * and a menu that is the same every time is one they learn to answer in a second.
 */
export interface OrientationRequest {
    /** The mentor's question, in its own voice. */
    prompt: string;
    /** Selectable goals. The caller may also accept free text. */
    options: string[];
}

export const ORIENTATION_OPTIONS = [
    "Getting it running",
    "Understanding how it works",
    "Making a specific change",
    "Just exploring",
];

export interface AnswerResult {
    answer: string;
    chunks: RetrievedChunk[];
    followUps: FollowUp[];
    intent: QuestionIntent;
    project?: RegistryProject;
    /** True when the user asked to rephrase instead of picking a project — nothing was answered. */
    cancelled: boolean;
    /** How well the documentation backed this answer. */
    coverage: AnswerCoverage;
    /** Where the learner is in the conversation, as judged for this turn. */
    stage: LearnerStage;
    /** Present when the flow needs more from the user before it can answer. */
    clarification?: ClarificationRequest;
    /** Present when the mentor asks why they are here before answering; the question is not answered. */
    orientation?: OrientationRequest;
}

/** A digest with nothing summarised yet, for a goal stated before the first refresh. */
function emptyDigest(): SessionDigest {
    return { summary: "", projectsDiscussed: [], jargonDefined: [], questionsAsked: [], coversUpToIndex: 0 };
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
    private carried: { turns: ChatTurn[]; activeProject?: string; learnerGoal?: string } | undefined;
    /** Set by startNewSession, consumed by the next resolve. */
    private forcedSession: SessionRef | undefined;
    /**
     * A check question the learner has not yet answered. Held in the process, not the store: a
     * check abandoned by closing the terminal should simply be gone.
     */
    private pendingQuiz: QuizQuestion | undefined;

    constructor(
        private readonly classifier: IntentClassifierAgent,
        private readonly router: ProjectRouterAgent,
        private readonly planner: RetrievalPlannerAgent,
        private readonly writer: AnswerWriterAgent,
        private readonly verify: VerificationAgent,
        private readonly followUps: FollowUpGeneratorAgent,
        private readonly quiz: QuizAgent,
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
        const stage = deriveStage(session);

        // A check is in progress: this input is the learner's answer, not a question, so it goes
        // straight to feedback and never near the classifier.
        if (this.pendingQuiz) {
            const quiz = this.pendingQuiz;
            this.pendingQuiz = undefined;
            const feedback = await this.quiz.assess({ quiz, learnerAnswer: question });
            return {
                answer: feedback,
                chunks: [],
                followUps: [{ question: QUIZ_MENU_TEXT, rationale: "" }],
                intent: QuestionIntent.QUIZ,
                cancelled: false,
                coverage: AnswerCoverage.NOT_APPLICABLE,
                stage,
            };
        }

        // The menu entry is matched literally, so choosing it costs no classifier call and does
        // not depend on a weak model recognising it.
        if (question.trim() === QUIZ_MENU_TEXT) {
            return this.poseQuiz(session, stage);
        }

        const classification = await this.classifier.classify({
            question,
            recentTurns,
            digest: session.digest,
        });
        // Pronouns resolved against the conversation, so retrieval searches for the real subject
        // rather than the literal words "and why does it do that".
        const effectiveQuestion = classification.resolvedQuestion.trim() || question;

        // A goal stated in passing is kept from that moment, not from the next digest refresh.
        const statedGoal = (classification.statedGoal ?? "").trim();
        if (statedGoal) {
            await this.setLearnerGoal(statedGoal);
            session.digest = { ...(session.digest ?? emptyDigest()), learnerGoal: statedGoal };
        }
        const learnerGoal = session.digest?.learnerGoal;

        if (classification.intent === QuestionIntent.QUIZ) {
            return this.poseQuiz(session, stage);
        }

        // Ask before answering when it is not yet clear why they are here. Only at first contact,
        // only for a question about a project, and never for a change question — someone asking
        // how to move a job to Friday has already said what they are here for.
        if (
            stage === LearnerStage.FIRST_CONTACT &&
            !learnerGoal &&
            classification.intent === QuestionIntent.PROJECT_KNOWLEDGE
        ) {
            return {
                answer: "",
                chunks: [],
                followUps: [],
                intent: classification.intent,
                cancelled: false,
                coverage: AnswerCoverage.NOT_APPLICABLE,
                stage,
                orientation: await this.orientationFor(classification.projectHints),
            };
        }

        const produced = await this.produceAnswer({
            classification: classification.intent,
            projectHints: classification.projectHints,
            crossProject: classification.crossProject,
            question: effectiveQuestion,
            session,
            sessionRef: ref,
            recentTurns,
            chooser,
            allowClarification,
            stage,
            learnerGoal,
        });

        if (produced.cancelled) {
            return { ...produced, intent: classification.intent, followUps: [], stage };
        }

        // A clarification is not an answer: nothing is recorded, so the user's reply is treated as
        // a fresh question rather than a follow-up to something that was never said.
        if (produced.clarification) {
            return { ...produced, intent: classification.intent, followUps: [], stage };
        }

        const assembled = this.isAssembledAnswer(classification.intent);

        // Two guards on anything a model wrote, both silent. Identifiers the sources never mention
        // are taken back by a single revision; anything shaped like a credential is redacted. The
        // reader sees the corrected answer, never a warning about it.
        const answer = assembled
            ? produced.answer
            : this.withSecretsRedacted(
                  await this.withUnsupportedIdentifiersRevised(
                      effectiveQuestion,
                      produced.answer,
                      produced.chunks,
                      recentTurns,
                  ),
              );
        const outcome = { ...produced, answer };

        // A greeting, a recap and "what do you know about?" are assembled in code from the
        // registry and the session — no model wrote them and nothing needs summarising. Running
        // the batch anyway cost two calls and produced the suggestions that made a greeting offer
        // to explain "the role of an engineer on a project".
        const completed = assembled
            ? await this.completeAssembledTurn(classification.intent, outcome.answer)
            : await this.completeWrittenTurn({
                  question: effectiveQuestion,
                  outcome,
                  digest: session.digest,
                  stage,
                  learnerGoal,
              });
        const followUps = this.withQuizOffer(completed.followUps, session, assembled);

        await this.recordTurn({
            store,
            ref,
            session,
            turn: {
                index: session.turns.length,
                question,
                answer: outcome.answer,
                answerGist: completed.answerGist,
                intent: classification.intent,
                resolvedProject: outcome.project?.slug,
                retrievedChunkIds: outcome.chunks.map((c) => c.location ?? "").filter(Boolean),
                createdAt: new Date().toISOString(),
            },
        });

        return { ...outcome, intent: classification.intent, followUps, stage };
    }

    /**
     * Records what the learner is here to do. Called by the CLI after an orientation prompt, and
     * by the flow itself when a goal is stated in passing. Persisted at once on the session's
     * digest so the next turn — and the next session — has it.
     */
    public async setLearnerGoal(goal: string): Promise<void> {
        const trimmed = goal.trim();
        if (!trimmed) return;
        const store = await this.stores.get();
        const { ref, session } = await this.resolveSession(store);
        await store.saveDigest(ref, { ...(session.digest ?? emptyDigest()), learnerGoal: trimmed });
        logger.debug(`Learner goal: ${trimmed}`);
    }

    /** The mentor's opening question, naming the project when one was recognised. */
    private async orientationFor(projectHints: string[]): Promise<OrientationRequest> {
        const named = projectHints.length > 0 ? (await this.registry.findByName(projectHints[0]))[0] : undefined;
        const subject = named ? named.displayName : "this";
        return {
            prompt: `Before I get into ${subject} — what are you here for? I'll pitch everything that follows to that.`,
            options: ORIENTATION_OPTIONS,
        };
    }

    /**
     * Poses one check question from what was recently explained, and holds it until the next
     * input. Not recorded as a turn: a recap that lists "quiz me" among the questions asked is
     * noise, and the check is about the conversation rather than part of it.
     */
    private async poseQuiz(session: ChatSession, stage: LearnerStage): Promise<AnswerResult> {
        const base = {
            chunks: [],
            followUps: [],
            intent: QuestionIntent.QUIZ,
            cancelled: false,
            coverage: AnswerCoverage.NOT_APPLICABLE,
            stage,
        };
        try {
            const quiz = await this.quiz.pose({
                turns: [...(session.carriedTurns ?? []), ...session.turns],
                digest: session.digest,
            });
            this.pendingQuiz = quiz;
            return { ...base, answer: quiz.question };
        } catch (err) {
            logger.debug(`Could not pose a check (${(err as Error).message}).`);
            return {
                ...base,
                answer: "There isn't enough covered yet for a proper check — ask me a couple of things first and I'll quiz you on them.",
            };
        }
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

    /** Offers a comprehension check every QUIZ_OFFER_INTERVAL written turns, counting this one. */
    private withQuizOffer(followUps: FollowUp[], session: ChatSession, assembled: boolean): FollowUp[] {
        if (assembled) return followUps;
        const written = session.turns.filter((turn) => !this.isAssembledAnswer(turn.intent)).length + 1;
        if (written < QUIZ_OFFER_INTERVAL || written % QUIZ_OFFER_INTERVAL !== 0) return followUps;
        return [...followUps, { question: QUIZ_MENU_TEXT, rationale: "" }];
    }

    /** Whether this intent is answered from the registry or session history rather than by a model. */
    private isAssembledAnswer(intent: QuestionIntent): boolean {
        return (
            intent === QuestionIntent.META ||
            intent === QuestionIntent.SMALL_TALK ||
            intent === QuestionIntent.CONVERSATION
        );
    }

    /**
     * Finishes a turn whose answer was assembled in code: no follow-up call and no summariser
     * call. The gist is written here because it is already known, and the suggestions come
     * from the registry, which offers something better than a model does — the projects actually
     * indexed, by name, instead of a guess at what someone greeting us might want.
     */
    private async completeAssembledTurn(
        intent: QuestionIntent,
        answer: string,
    ): Promise<{ followUps: FollowUp[]; answerGist: string }> {
        const gists: Record<string, string> = {
            [QuestionIntent.META]: "listed the projects currently indexed",
            [QuestionIntent.SMALL_TALK]: "exchanged a greeting",
            [QuestionIntent.CONVERSATION]: "recapped what this conversation has covered",
        };

        // A recap offering "tell me about X" would talk over itself, so only the two intents that
        // are genuinely an opening get project suggestions.
        const suggestProjects = intent === QuestionIntent.META || intent === QuestionIntent.SMALL_TALK;
        const { projects } = suggestProjects ? await this.registry.load() : { projects: [] };

        return {
            followUps: projects.slice(0, ASSEMBLED_FOLLOW_UP_COUNT).map((project) => ({
                question: `Tell me about ${project.displayName}`,
                rationale: "",
            })),
            answerGist: gists[intent] ?? answer.trim().slice(0, 200),
        };
    }

    /**
     * Finishes a turn a model wrote. Both calls need the finished answer and neither needs the
     * other, so they run together and cost one round trip rather than two.
     */
    private async completeWrittenTurn(params: {
        question: string;
        outcome: { answer: string; chunks: RetrievedChunk[]; project?: RegistryProject };
        digest?: SessionDigest;
        stage: LearnerStage;
        learnerGoal?: string;
    }): Promise<{ followUps: FollowUp[]; answerGist: string }> {
        const { question, outcome, digest, stage, learnerGoal } = params;
        const [followUps, answerGist] = await Promise.all([
            this.followUps.suggest({
                question,
                answer: outcome.answer,
                chunks: outcome.chunks,
                digest,
                projectDisplayName: outcome.project?.displayName,
                stage,
                learnerGoal,
            }),
            this.writer.summarize(question, outcome.answer),
        ]);
        return { followUps, answerGist };
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
        stage: LearnerStage;
        learnerGoal?: string;
    }): Promise<{
        answer: string;
        chunks: RetrievedChunk[];
        project?: RegistryProject;
        cancelled: boolean;
        coverage: AnswerCoverage;
        clarification?: ClarificationRequest;
    }> {
        const { classification, question, session, recentTurns, stage, learnerGoal } = params;
        const noRetrieval = { chunks: [], cancelled: false, coverage: AnswerCoverage.NOT_APPLICABLE };

        if (classification === QuestionIntent.META) {
            return { answer: await this.describeCorpus(), ...noRetrieval };
        }

        if (classification === QuestionIntent.SMALL_TALK) {
            return { answer: await this.greet(), ...noRetrieval };
        }

        if (classification === QuestionIntent.CONVERSATION) {
            return { answer: await this.recall(session, params.sessionRef), ...noRetrieval };
        }

        if (classification === QuestionIntent.GENERAL_TECHNICAL) {
            // Check the corpus even though the classifier called this general. The classifier
            // judged the wording; only the corpus knows whether we have written anything about it,
            // and answering "how should retries work?" from textbook knowledge while our own
            // retry page sits unread is the failure this exists to prevent.
            const chunks = await this.probeForHouseAnswer(question);
            const answer = await this.writer.general({
                question,
                recentTurns,
                digest: session.digest,
                chunks,
                learnerGoal,
            });
            return {
                answer,
                chunks,
                cancelled: false,
                coverage: chunks.length > 0 ? AnswerCoverage.BLENDED : AnswerCoverage.NOT_APPLICABLE,
            };
        }

        // A question spanning projects must not inherit the sticky project: narrowing it would
        // report on one project in language that sounds like it covered them all. A change
        // question is excluded: you change one system at a time, and a cross-project change plan
        // would be a plan for nowhere in particular.
        if (params.crossProject && classification !== QuestionIntent.CHANGE_IMPACT) {
            const retrieved = await this.retrieveForAnswer(question, undefined, []);
            const empty = await this.emptyContextOutcome(retrieved, undefined);
            if (empty) return empty;

            const gate = await this.verify.screen({ question, chunks: retrieved.chunks });
            if (this.shouldClarify(gate, params.allowClarification)) {
                return {
                    answer: "",
                    chunks: retrieved.chunks,
                    cancelled: false,
                    coverage: AnswerCoverage.DOCUMENTED,
                    clarification: this.toClarification(gate),
                };
            }
            const answer = await this.writer.describe({
                question,
                chunks: retrieved.chunks,
                recentTurns,
                digest: session.digest,
                stage,
                learnerGoal,
            });
            return { answer, chunks: retrieved.chunks, cancelled: false, coverage: AnswerCoverage.DOCUMENTED };
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
                return { answer: "", chunks: [], cancelled: true, coverage: AnswerCoverage.NOT_APPLICABLE };
            }
            if (choice.kind === "project") {
                project = decision.candidates.find((c) => c.project.slug === choice.slug)?.project;
            }
        }

        // A change question needs several searches, not a deeper one, so it takes its own
        // retrieval path — but only after routing, because the searches must be project-filtered.
        const isChange = classification === QuestionIntent.CHANGE_IMPACT;
        const retrieved = isChange
            ? await this.retrieveForChange(question, project, recentTurns)
            : await this.retrieveForAnswer(question, project, decision.probeChunks);
        const empty = await this.emptyContextOutcome(retrieved, project);
        if (empty) return empty;

        if (isChange) {
            const answer = await this.writer.advise({
                question,
                chunks: retrieved.chunks,
                projectDisplayName: project?.displayName,
                recentTurns,
                digest: session.digest,
                learnerGoal,
            });
            return { answer, chunks: retrieved.chunks, project, cancelled: false, coverage: AnswerCoverage.DOCUMENTED };
        }

        const gate = await this.verify.screen({ question, chunks: retrieved.chunks });
        if (this.shouldClarify(gate, params.allowClarification)) {
            return {
                answer: "",
                chunks: retrieved.chunks,
                project,
                cancelled: false,
                coverage: AnswerCoverage.DOCUMENTED,
                clarification: this.toClarification(gate),
            };
        }

        const answer = await this.writer.describe({
            question,
            chunks: retrieved.chunks,
            projectDisplayName: project?.displayName,
            recentTurns,
            digest: session.digest,
            stage,
            learnerGoal,
        });

        return { answer, chunks: retrieved.chunks, project, cancelled: false, coverage: AnswerCoverage.DOCUMENTED };
    }

    /**
     * Looks for a house answer to a general question. Failure is silent and returns nothing: the
     * general answer is still worth giving, and an unreachable knowledge base is not a reason to
     * withhold an explanation that never depended on it.
     */
    private async probeForHouseAnswer(question: string): Promise<RetrievedChunk[]> {
        const { projects } = await this.registry.load();
        if (projects.length === 0) return [];

        try {
            return await this.knowledgeBase.retrieve(question, { numberOfResults: GENERAL_PROBE_RESULT_COUNT });
        } catch (err) {
            logger.debug(`House-answer probe failed (${(err as Error).message}) — answering generally only.`);
            return [];
        }
    }

    /**
     * Retrieval for a change question: plan several searches, run them together, merge the results.
     *
     * The searches are independent, so they run in parallel and cost one round trip rather than
     * four. `allSettled` because one failed angle should narrow the answer, not lose it.
     */
    private async retrieveForChange(
        question: string,
        project: RegistryProject | undefined,
        recentTurns: ChatTurn[],
    ): Promise<{ chunks: RetrievedChunk[]; failed: boolean }> {
        const plan = await this.planner.plan({
            question,
            projectDisplayName: project?.displayName,
            priorSubject: recentTurns[recentTurns.length - 1]?.answerGist,
        });

        const settled = await Promise.allSettled(
            plan.queries.map((query) =>
                this.knowledgeBase.retrieve(query, {
                    project: project?.slug,
                    numberOfResults: PLANNED_RESULT_COUNT,
                }),
            ),
        );

        const failures = settled.filter((r) => r.status === "rejected").length;
        if (failures > 0) {
            logger.warn(`${failures} of ${plan.queries.length} planned retrievals failed.`);
        }

        const chunks = this.mergeChunks(
            settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        );
        logger.debug(`Planned retrieval merged to ${chunks.length} chunk(s) from ${plan.queries.length} search(es).`);

        return { chunks, failed: chunks.length === 0 && failures === plan.queries.length };
    }

    /**
     * Merges the per-query results into one ranked set.
     *
     * Overlap between the searches is expected and is itself a signal — a document several angles
     * agree on is usually the one that matters — so a repeat keeps its best score and is ranked
     * higher, rather than being thrown away.
     */
    private mergeChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
        const byKey = new Map<string, { chunk: RetrievedChunk; hits: number; score: number }>();

        for (const chunk of chunks) {
            // Content, not location: a document arrives as several chunks under one S3 URI, and
            // keying on the URI would discard every chunk of it but the first.
            const key = `${chunk.location ?? ""}::${chunk.content.trim().slice(0, 200)}`;
            const existing = byKey.get(key);
            if (existing) {
                existing.hits += 1;
                existing.score = Math.max(existing.score, chunk.score ?? 0);
                continue;
            }
            byKey.set(key, { chunk, hits: 1, score: chunk.score ?? 0 });
        }

        return [...byKey.values()]
            .sort((a, b) => b.hits - a.hits || b.score - a.score)
            .slice(0, MERGED_RESULT_CAP)
            .map((entry) => entry.chunk);
    }

    /**
     * The outcome for a question nothing was retrieved for, or `undefined` when there is context
     * to answer from.
     *
     * This is the guardrail the reported behaviour was missing. Previously an empty retrieval
     * still reached the answering model — the grounding check returned "wrong_subject" but with
     * no alternative questions, which `shouldClarify` reads as "do not stop" — and the model was
     * handed "(No relevant context was found)" and asked to answer anyway. Whatever it then wrote
     * came from general knowledge wearing the voice of our documentation.
     *
     * The reply is assembled here rather than generated, because a model asked to say "I don't
     * know" will often take one more guess at the answer on its way.
     */
    private async emptyContextOutcome(
        retrieved: { chunks: RetrievedChunk[]; failed: boolean },
        project: RegistryProject | undefined,
    ): Promise<
        | { answer: string; chunks: []; project?: RegistryProject; cancelled: false; coverage: AnswerCoverage }
        | undefined
    > {
        if (retrieved.chunks.length > 0) return undefined;

        const base = retrieved.failed
            ? "I could not reach the knowledge base just now, so I have nothing to answer from. Please try again in a moment."
            : project
              ? `I could not find anything about that in the ${project.displayName} documentation, so I am not going to guess.`
              : "I could not find anything about that in the indexed documentation, so I am not going to guess.";

        const parts = [base];
        if (!retrieved.failed) {
            const { projects } = await this.registry.load();
            if (projects.length > 0) {
                parts.push("", `Indexed right now: ${projects.map((p) => p.displayName).join(", ")}.`);
            }
            parts.push(
                "",
                "If you think it should be there, it may be worded differently — try naming the specific file, table, screen or job you mean. If it genuinely is not documented, that gap is worth raising with whoever owns the project.",
            );
        }

        return {
            answer: parts.join("\n"),
            chunks: [],
            project,
            cancelled: false,
            coverage: AnswerCoverage.NOT_DOCUMENTED,
        };
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
     *
     * `failed` separates "the corpus has nothing on this" from "we could not ask the corpus".
     * Both end up with no chunks, but they are different things to tell someone, and only the
     * second is worth retrying.
     */
    private async retrieveForAnswer(
        question: string,
        project: RegistryProject | undefined,
        probeChunks: RetrievedChunk[],
    ): Promise<{ chunks: RetrievedChunk[]; failed: boolean }> {
        try {
            if (project) {
                const chunks = await this.knowledgeBase.retrieve(question, {
                    project: project.slug,
                    numberOfResults: ANSWER_RESULT_COUNT,
                });
                return { chunks, failed: false };
            }
            if (probeChunks.length > 0) return { chunks: probeChunks, failed: false };
            const chunks = await this.knowledgeBase.retrieve(question, { numberOfResults: ANSWER_RESULT_COUNT });
            return { chunks, failed: false };
        } catch (err) {
            logger.warn(`Retrieval failed: ${(err as Error).message}`);
            // The probe, if there was one, still came from the corpus — better than nothing.
            return { chunks: probeChunks, failed: probeChunks.length === 0 };
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
                // A goal from an earlier session holds until the learner states a new one.
                digest:
                    session.digest?.learnerGoal || !this.carried?.learnerGoal
                        ? session.digest
                        : { ...(session.digest ?? emptyDigest()), learnerGoal: this.carried.learnerGoal },
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
        this.pendingQuiz = undefined;
        this.forcedSession = { ownerId: getOwnerId(), sessionId: newSessionId() };
        this.currentRef = undefined;
        this.carried = undefined;
    }
}
