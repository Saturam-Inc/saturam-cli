/**
 * Conversation state for the knowledge-base answering flow.
 *
 * A session is a sequence of turns plus a rolling digest. The agent never receives the raw turn
 * list — it receives the last few turns as attributed messages plus the digest, which is what
 * keeps a 20+ turn history affordable. The full history is still reachable, but only when the
 * agent asks for it through its `recall_conversation` tool.
 *
 * There used to be a `QuestionIntent` enum here with nine members, and a `LearnerStage` enum with
 * four. Both were code trying to describe a question, or a person, before the agent had looked at
 * anything — and both were consulted to pick a fixed reply or a fixed answer length. The agent
 * reads the conversation directly, so neither is needed to hold that information any more.
 */

export interface ChatTurn {
    /** Monotonic index within the session, 0-based — also the DynamoDB sort key. */
    index: number;
    question: string;
    /** The full answer as rendered to the user. */
    answer: string;
    /**
     * One-line summary of the answer. This is what the agent receives in place of the full text:
     * a mentor-style answer runs 400-600 tokens, and twenty of them would dominate every prompt.
     */
    answerGist: string;
    /** Project slug this turn's evidence came from, if it came from one. */
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
    /** Internal terms already defined, so the agent does not re-explain them. */
    jargonDefined: string[];
    /** Questions already asked, so the follow-up generator does not re-suggest them. */
    questionsAsked: string[];
    /** Turn index this digest covers up to (exclusive). */
    coversUpToIndex: number;
    /**
     * What the learner said they are here to do — "get it running locally", "understand the
     * scheduler before on-call", "move the weekly job to Friday". Read out of what they actually
     * said rather than asked for by a fixed opening menu, and carried into later sessions.
     */
    learnerGoal?: string;
}

export interface ChatSession {
    sessionId: string;
    turns: ChatTurn[];
    /** Read-only context from the owner's previous sessions; never persisted under this session. */
    carriedTurns?: ChatTurn[];
    /** Sticky project, carried across turns until the subject changes. */
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
 * recent history back gives the agent enough to tell a continuation from a fresh subject, which
 * is what makes "so what tech stacks are used" resolvable in a new terminal.
 */
export const CARRY_OVER_TURNS = 5;

/**
 * The turns the agent sees up front: this session's own turns, preceded by whatever was carried
 * over, trimmed to the verbatim window. Carried turns are context only — they are never rewritten,
 * and new turns are always appended to the current session.
 */
export function contextTurns(session: ChatSession): ChatTurn[] {
    return [...(session.carriedTurns ?? []), ...session.turns].slice(-VERBATIM_TURN_WINDOW);
}

/**
 * The index the next turn in this session takes. Read off the last retained turn rather than
 * `turns.length`: stores keep only the last MAX_RETAINED_TURNS, so past that point the array stops
 * growing while the conversation does not, and its length is no longer a position in it.
 */
export function nextTurnIndex(session: ChatSession): number {
    return (session.turns.at(-1)?.index ?? -1) + 1;
}

export function createEmptySession(sessionId: string): ChatSession {
    return { sessionId, turns: [] };
}
