import { Service } from "typedi";
import { ChatSession, ChatTurn, MAX_RETAINED_TURNS, SessionDigest, createEmptySession } from "./chat-session.model";

/**
 * Persistence port for conversation history.
 *
 * Two implementations: in-memory (default, and the only one that works without AWS access) and
 * DynamoDB (for history that outlives the process, and for the phase-2 frontend). The flow
 * depends on this interface only, so neither the orchestrator nor the agents know which is in use.
 */
export interface ConversationStore {
    load(sessionId: string): Promise<ChatSession>;
    appendTurn(sessionId: string, turn: ChatTurn): Promise<void>;
    saveDigest(sessionId: string, digest: SessionDigest): Promise<void>;
    saveActiveProject(sessionId: string, project: string | undefined): Promise<void>;
}

/**
 * Process-local store. Keeps the last MAX_RETAINED_TURNS turns; older ones survive only through
 * the digest, which is the same trimming contract the DynamoDB store applies on read.
 */
@Service()
export class InMemoryConversationStore implements ConversationStore {
    private readonly sessions = new Map<string, ChatSession>();

    public async load(sessionId: string): Promise<ChatSession> {
        return this.sessions.get(sessionId) ?? createEmptySession(sessionId);
    }

    public async appendTurn(sessionId: string, turn: ChatTurn): Promise<void> {
        const session = await this.load(sessionId);
        const turns = [...session.turns, turn].slice(-MAX_RETAINED_TURNS);
        this.sessions.set(sessionId, { ...session, turns });
    }

    public async saveDigest(sessionId: string, digest: SessionDigest): Promise<void> {
        const session = await this.load(sessionId);
        this.sessions.set(sessionId, { ...session, digest });
    }

    public async saveActiveProject(sessionId: string, project: string | undefined): Promise<void> {
        const session = await this.load(sessionId);
        this.sessions.set(sessionId, { ...session, activeProject: project });
    }
}
