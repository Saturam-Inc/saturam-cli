/**
 * Conversation state for the knowledge-base answering flow.
 *
 * A session is a sequence of turns plus a rolling digest. Agents never receive the raw turn
 * list — they receive the last few turns as attributed messages plus the digest, which is what
 * keeps a 20+ turn history affordable on the classifier (the most frequent call in the flow).
 */

/** What the intent classifier decides a question is. */
export enum QuestionIntent {
    /** Answerable from general engineering knowledge, no knowledge base needed. */
    GENERAL_TECHNICAL = "general_technical",
    /** About one of our internal projects — needs retrieval. */
    PROJECT_KNOWLEDGE = "project_knowledge",
    /**
     * About changing one of our systems, or about what a change would do: "what do I edit to move
     * the schedule to Friday?", "what breaks if I change this path?", "how do I add a new domain?".
     *
     * Separated from PROJECT_KNOWLEDGE because it fails differently. A descriptive question is
     * answered by the documents that describe the thing; a change question is answered by the
     * documents that say where it is configured, what triggers it, and what reads it downstream —
     * which are rarely the same documents, and rarely the ones a single search on the question's
     * own wording returns.
     */
    CHANGE_IMPACT = "change_impact",
    /** About the assistant or the corpus itself ("what can you tell me about?"). */
    META = "meta",
    /**
     * About the conversation so far ("what was I asking about?", "recap what we covered").
     * Answered from session history, not from retrieval — running the full answering pipeline
     * re-explains the topic at length instead of simply recalling it.
     */
    CONVERSATION = "conversation",
    /** A greeting, thanks, or other pleasantry — answered briefly, with no retrieval or recall. */
    SMALL_TALK = "small_talk",
    /**
     * The learner asks to be checked on what they have covered ("quiz me", "test me on this").
     * Answered from the session's own recent answers, with no retrieval: the point is to find out
     * what stuck, not to teach something new.
     */
    QUIZ = "quiz",
}

/**
 * Where the learner is in the conversation, derived from the session rather than asked.
 *
 * This is what lets the same question get a different answer on turn one and turn eight. Without
 * it every turn was answered as if it were the first — complete, self-contained, and the same
 * length whether the reader had just arrived or had spent twenty minutes on the scheduler.
 */
export enum LearnerStage {
    /** Nothing asked yet, nothing carried over, no goal known — the mentor should find out why they are here. */
    FIRST_CONTACT = "first_contact",
    /** Nothing asked in this run, but earlier sessions carried in — pick up where they left off. */
    RETURNING = "returning",
    /** Goal known, still early — orient them: the shape of the thing and the one point to hold onto. */
    ORIENTING = "orienting",
    /** Several turns in — go as deep as the question needs and build on what was covered. */
    DEEPENING = "deepening",
}

export function deriveStage(session: ChatSession): LearnerStage {
    if (session.turns.length === 0) {
        if ((session.carriedTurns?.length ?? 0) > 0) return LearnerStage.RETURNING;
        return session.digest?.learnerGoal ? LearnerStage.ORIENTING : LearnerStage.FIRST_CONTACT;
    }
    return session.turns.length < 2 ? LearnerStage.ORIENTING : LearnerStage.DEEPENING;
}

/** How many written turns between offers of a comprehension check. */
export const QUIZ_OFFER_INTERVAL = 4;

/**
 * The menu entry that starts a check. Matched literally by the flow before classification, so
 * choosing it never costs a classifier call and never depends on a weak model recognising it.
 */
export const QUIZ_MENU_TEXT = "Quick check — quiz me on what we've covered";

export interface ChatTurn {
    /** Monotonic index within the session, 0-based — also the DynamoDB sort key. */
    index: number;
    question: string;
    /** The full answer as rendered to the user. */
    answer: string;
    /**
     * One-line summary of the answer. This is what agents receive in place of the full text:
     * a mentor-style answer runs 400-600 tokens, and twenty of them would dominate every prompt.
     */
    answerGist: string;
    intent: QuestionIntent;
    /** Project slug this turn resolved to, if any. */
    resolvedProject?: string;
    /** Chunk locations used for this answer, so follow-ups avoid re-treading them. */
    retrievedChunkIds: string[];
    createdAt: string;
}

/**
 * Compact summary of everything older than the verbatim window. Regenerated every
 * DIGEST_REFRESH_INTERVAL turns rather than every turn, so it costs roughly one extra LLM
 * call per five questions.
 */
export interface SessionDigest {
    /** Prose summary of what the conversation has covered. */
    summary: string;
    /** Projects discussed so far, most recent first. */
    projectsDiscussed: string[];
    /** Internal terms already defined, so the mentor answerer does not re-explain them. */
    jargonDefined: string[];
    /** Questions already asked, so the follow-up generator does not re-suggest them. */
    questionsAsked: string[];
    /** Turn index this digest covers up to (exclusive). */
    coversUpToIndex: number;
    /**
     * What the learner said they are here to do — "get it running locally", "understand the
     * scheduler before on-call", "move the weekly job to Friday". Set the moment it is stated
     * rather than at the next digest refresh, and carried into later sessions. Lives on the
     * digest because the digest is already the one persisted, per-session summary object.
     */
    learnerGoal?: string;
}

export interface ChatSession {
    sessionId: string;
    turns: ChatTurn[];
    /** Read-only context from the owner's previous sessions; never persisted under this session. */
    carriedTurns?: ChatTurn[];
    /** Sticky project, carried across turns until the user changes topic. */
    activeProject?: string;
    digest?: SessionDigest;
}

/** Turns sent verbatim (as Human/AI message pairs) before the digest takes over. */
export const VERBATIM_TURN_WINDOW = 3;

/** How many turns pass between digest regenerations. */
export const DIGEST_REFRESH_INTERVAL = 5;

/** Turns retained in a session; older ones survive only through the digest. */
export const MAX_RETAINED_TURNS = 20;

/**
 * Turns carried into a new session from the owner's previous ones.
 *
 * Every run is its own session, so without this a new terminal would start blind. Reading the
 * recent history back gives the classifier and router enough to tell a continuation from a fresh
 * subject, which is what makes "so what tech stacks are used" resolvable in a new terminal.
 */
export const CARRY_OVER_TURNS = 5;

/**
 * The turns agents actually see: this session's own turns, preceded by whatever was carried over,
 * trimmed to the verbatim window. Carried turns are context only — they are never rewritten, and
 * new turns are always appended to the current session.
 */
export function contextTurns(session: ChatSession): ChatTurn[] {
    return [...(session.carriedTurns ?? []), ...session.turns].slice(-VERBATIM_TURN_WINDOW);
}

export function createEmptySession(sessionId: string): ChatSession {
    return { sessionId, turns: [] };
}
