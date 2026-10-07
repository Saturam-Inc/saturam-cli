import { Service } from "typedi";
import { ChatSession, ChatTurn, MAX_RETAINED_TURNS, SessionDigest, createEmptySession } from "./chat-session.model";
import { SessionRef } from "./session-identity";

/**
 * Persistence port for conversation history.
 *
 * Addressed by owner plus session rather than by session alone: the owner is what lets a new
 * terminal find the conversation already in progress, and it is the natural place a real user id
 * slots in when this moves behind a shared backend.
 */
export interface ConversationStore {
    /** Session ids for this owner, newest first. Empty when the owner has no history. */
    findRecentSessionIds(ownerId: string, limit: number): Promise<string[]>;
    load(ref: SessionRef): Promise<ChatSession>;
    appendTurn(ref: SessionRef, turn: ChatTurn): Promise<void>;
    saveDigest(ref: SessionRef, digest: SessionDigest): Promise<void>;
    saveActiveProject(ref: SessionRef, project: string | undefined): Promise<void>;
}

/** Composite key for the in-process map, mirroring the DynamoDB partition/sort split. */
function key(ref: SessionRef): string {
    return `${ref.ownerId}|${ref.sessionId}`;
}

/**
 * Process-local store. Keeps the last MAX_RETAINED_TURNS turns per session; older ones survive
 * only through the digest, which is the same trimming contract the DynamoDB store applies on read.
 */
@Service()
export class InMemoryConversationStore implements ConversationStore {
    private readonly sessions = new Map<string, ChatSession>();
    /** Insertion order per owner, so "most recent session" is answerable without timestamps. */
    private readonly byOwner = new Map<string, string[]>();

    public async findRecentSessionIds(ownerId: string, limit: number): Promise<string[]> {
        return [...(this.byOwner.get(ownerId) ?? [])].reverse().slice(0, limit);
    }

    public async load(ref: SessionRef): Promise<ChatSession> {
        return this.sessions.get(key(ref)) ?? createEmptySession(ref.sessionId);
    }

    public async appendTurn(ref: SessionRef, turn: ChatTurn): Promise<void> {
        const session = await this.load(ref);
        const turns = [...session.turns, turn].slice(-MAX_RETAINED_TURNS);
        this.sessions.set(key(ref), { ...session, turns });
        this.track(ref);
    }

    public async saveDigest(ref: SessionRef, digest: SessionDigest): Promise<void> {
        const session = await this.load(ref);
        this.sessions.set(key(ref), { ...session, digest });
        this.track(ref);
    }

    public async saveActiveProject(ref: SessionRef, project: string | undefined): Promise<void> {
        const session = await this.load(ref);
        this.sessions.set(key(ref), { ...session, activeProject: project });
        this.track(ref);
    }

    private track(ref: SessionRef): void {
        const known = this.byOwner.get(ref.ownerId) ?? [];
        if (!known.includes(ref.sessionId)) {
            this.byOwner.set(ref.ownerId, [...known, ref.sessionId]);
        }
    }
}
