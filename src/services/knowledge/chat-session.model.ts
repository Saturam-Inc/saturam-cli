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
    /** About the assistant or the corpus itself ("what can you tell me about?"). */
    META = "meta",
}

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
}

export interface ChatSession {
    sessionId: string;
    turns: ChatTurn[];
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

export function createEmptySession(sessionId: string): ChatSession {
    return { sessionId, turns: [] };
}
