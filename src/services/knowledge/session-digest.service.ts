import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { SESSION_DIGEST_SHAPE_HINT, getSessionDigestMessages } from "../../prompts/session-digest.prompt";
import { ChatSession, DIGEST_REFRESH_INTERVAL, SessionDigest, VERBATIM_TURN_WINDOW } from "./chat-session.model";
import { StructuredOutputService } from "./structured-output";

const logger = getLogger("SessionDigest");

const TEMPERATURE = 0;

export const DigestSchema = z.object({
    summary: z.string().default(""),
    projectsDiscussed: z.array(z.string()).default([]),
    jargonDefined: z.array(z.string()).default([]),
    questionsAsked: z.array(z.string()).default([]),
});

/**
 * Maintains the rolling conversation summary.
 *
 * Refreshed every DIGEST_REFRESH_INTERVAL turns rather than every turn: the digest only has to
 * cover history that has already fallen outside the verbatim window, so regenerating it per turn
 * would add an LLM call per question to restate what barely changed.
 */
@Service()
export class SessionDigestService {
    constructor(private readonly structured: StructuredOutputService) {}

    /** Whether enough turns have accumulated beyond the verbatim window to warrant a refresh. */
    public shouldRefresh(session: ChatSession): boolean {
        const coveredUpTo = session.digest?.coversUpToIndex ?? 0;
        const eligible = Math.max(0, session.turns.length - VERBATIM_TURN_WINDOW);
        return eligible - coveredUpTo >= DIGEST_REFRESH_INTERVAL;
    }

    public async refresh(session: ChatSession): Promise<SessionDigest | undefined> {
        const coveredUpTo = session.digest?.coversUpToIndex ?? 0;
        const eligible = session.turns.slice(0, Math.max(0, session.turns.length - VERBATIM_TURN_WINDOW));
        const newTurns = eligible.slice(coveredUpTo);
        if (newTurns.length === 0) return session.digest;

        try {
            const result = await this.structured.invoke({
                schema: DigestSchema,
                name: "update_session_digest",
                shapeHint: SESSION_DIGEST_SHAPE_HINT,
                messages: getSessionDigestMessages({ turns: newTurns, previousDigest: session.digest }),
                options: { temperature: TEMPERATURE },
            });
            return { ...result, coversUpToIndex: eligible.length };
        } catch (err) {
            // Keep the previous digest rather than dropping history on a transient failure.
            logger.debug(`Digest refresh failed: ${(err as Error).message}`);
            return session.digest;
        }
    }
}
