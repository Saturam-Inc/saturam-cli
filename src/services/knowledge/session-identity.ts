import { hostname, userInfo } from "os";
import { randomBytes } from "crypto";
import { slugify } from "../../utils/slug.util";

/**
 * Identity and session naming for conversation history.
 *
 * The owner is derived from the machine and the OS user rather than stored in a config file, so
 * every terminal on a machine resolves to the same owner with nothing to keep in sync. Sessions
 * live underneath it, which is what lets a new terminal pick up the conversation already in
 * progress instead of starting blind.
 */

/** Stable identity for "this person on this machine". */
export function getOwnerId(): string {
    const machine = slugify(hostname()) || "unknown-machine";
    const user = slugify(userInfo().username) || "unknown-user";
    return `owner#${machine}#${user}`;
}

/** Human-readable form of an owner id, for logs and diagnostics. */
export function describeOwner(ownerId: string): string {
    const [, machine, user] = ownerId.split("#");
    return `${user}@${machine}`;
}

/**
 * A session id that sorts chronologically as a string.
 *
 * This is what makes "continue the most recent conversation" a single descending query rather
 * than a scan: the newest session is simply the largest sort key. A random suffix keeps two
 * sessions started in the same second distinct.
 */
export function newSessionId(now: Date = new Date()): string {
    const stamp = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
    return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Session ids contain no "#", so they can be embedded in a sort key and parsed back out. */
export function isValidSessionId(sessionId: string): boolean {
    return sessionId.length > 0 && !sessionId.includes("#");
}

export interface SessionRef {
    ownerId: string;
    sessionId: string;
}
