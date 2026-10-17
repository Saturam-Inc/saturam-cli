import { getLogger } from "log4js";
import { Service } from "typedi";
import { S3ObjectError, S3Service } from "../../integrations/aws/services/s3.service";
import { ConfigService } from "../config-service";
import { CODE_CATEGORY, isRepositoryIndexDocument } from "./knowledge-source.model";
import { ProjectRegistryService, repoFullName } from "./project-registry.service";

const logger = getLogger("DocumentReader");

/**
 * Characters handed back per read. About 60 KB: a whole module of ordinary size in one call,
 * short of what would crowd the question itself out of the model's context. A longer document
 * is read in parts, by line range.
 */
export const MAX_READ_CHARS = 60_000;

export interface ReadRange {
    startLine?: number;
    endLine?: number;
}

export interface DocumentSlice {
    /** Content-relative S3 key the document was read from. */
    key: string;
    /** For a source file, its path inside the repository. */
    path?: string;
    /** What the agent sees: the document, or the requested part of it, rendered for reading. */
    content: string;
    /** Names the read establishes as real — the key, the path, the title — for the identifier guard. */
    identifiers: string[];
}

/** A source-file document split at the fence the pipeline wrapped the code in. */
interface CodeDocument {
    header: string;
    sourceLines: string[];
}

/**
 * Without s3:ListBucket, S3 answers a missing key with 403 AccessDenied rather than 404, so as not
 * to reveal which keys exist. The agent cannot tell the two apart either, so both are "not there".
 * The S3 service keeps the code and status on the error; the message is only a fallback for an
 * error that came some other way.
 */
function isNotFound(err: unknown): boolean {
    const { code, statusCode, message = "" } = (err as Partial<S3ObjectError>) ?? {};
    if (code && /^(NoSuchKey|NotFound|AccessDenied|Forbidden)$/.test(code)) return true;
    if (statusCode === 404 || statusCode === 403) return true;
    return /NoSuchKey|NotFound|not found|does not exist|404|Access ?Denied|Forbidden|403/i.test(message);
}

/**
 * Reads whole documents out of the corpus for the agent.
 *
 * Retrieval returns slices — a few hundred tokens of a file, chosen by similarity — and a slice
 * of code rarely holds the whole function, let alone what calls it. This is the step from "a
 * passage mentions it" to "I have read it": the same object Bedrock chunked, fetched from S3 and
 * handed over in full or by line range.
 *
 * Everything it reads sits under the content prefix. A reference is resolved to a key before
 * anything is fetched, and a reference that resolves anywhere else — another bucket, the state
 * prefix, a path climbing out — is refused with a reason the agent can act on, never fetched.
 */
@Service()
export class DocumentReaderService {
    constructor(
        private readonly s3: S3Service,
        private readonly config: ConfigService,
        private readonly registry: ProjectRegistryService,
    ) {}

    /**
     * The content-relative key a retrieval result's S3 URI names, or undefined when the URI is
     * not under this deployment's content prefix (or S3 is not configured at all). This is the
     * id a search result shows the agent, and what `read` accepts back.
     */
    public async documentIdOf(location: string | undefined): Promise<string | undefined> {
        if (!location?.startsWith("s3://")) return undefined;
        try {
            return this.keyOfUri(location, await this.config.getS3Config());
        } catch {
            return undefined;
        }
    }

    public async read(reference: string, range: ReadRange = {}): Promise<DocumentSlice> {
        const key = await this.resolveKey(reference);
        const text = await this.fetch(key);
        const path = this.sourcePathOf(key);
        const code = path ? this.splitCodeDocument(text) : undefined;

        const identifiers = [key, ...(path ? [path] : []), ...this.titlesIn(text)];
        const content = code ? this.renderCode(code, path!, range) : this.renderProse(text, range);
        logger.debug(`Read ${key}${code ? ` (${code.sourceLines.length} source lines)` : ""}`);
        return { key, path, content, identifiers };
    }

    /**
     * Turns what the agent was given into a key under the content prefix. Three forms are
     * accepted, because the agent meets documents in three ways: the id a search result shows,
     * the `repo:path` a repository listing shows, and the raw S3 URI a chunk carries.
     */
    public async resolveKey(reference: string): Promise<string> {
        const trimmed = reference.trim();
        if (!trimmed) throw new Error("A document reference is required.");

        if (trimmed.startsWith("s3://")) {
            const key = this.keyOfUri(trimmed, await this.config.getS3Config());
            if (!key)
                throw new Error(
                    `${trimmed} is not under this deployment's documentation bucket, so it cannot be read.`,
                );
            return key;
        }

        const repoRef = /^([\w.-]+\/[\w.-]+):(.+)$/.exec(trimmed);
        if (repoRef) return this.keyOfRepoPath(repoRef[1], repoRef[2].trim());

        return this.sanitize(trimmed);
    }

    private keyOfUri(uri: string, s3: { bucket: string; prefix?: string }): string | undefined {
        const withoutScheme = uri.slice("s3://".length);
        const slash = withoutScheme.indexOf("/");
        if (slash < 0) return undefined;
        const bucket = withoutScheme.slice(0, slash);
        const key = withoutScheme.slice(slash + 1);
        if (bucket !== s3.bucket) return undefined;

        const prefix = s3.prefix?.replace(/\/+$/, "");
        if (!prefix) return this.safeKeyOrUndefined(key);
        // Whole segments only: "onboarding/" must not match "onboarding-state/...".
        if (!key.startsWith(`${prefix}/`)) return undefined;
        return this.safeKeyOrUndefined(key.slice(prefix.length + 1));
    }

    /** `workspace/repo:path` → the key the pipeline wrote that file under, via the registry. */
    private async keyOfRepoPath(repo: string, path: string): Promise<string> {
        const wanted = repo.toLowerCase();
        const { projects } = await this.registry.load();
        for (const project of projects) {
            for (const candidate of project.repos ?? []) {
                const names = [repoFullName(candidate), candidate.repoSlug, candidate.folder].map((n) =>
                    n.toLowerCase(),
                );
                if (names.includes(wanted)) {
                    return this.sanitize(`${project.slug}/${CODE_CATEGORY}/${candidate.folder}/${path}`);
                }
            }
        }
        throw new Error(
            `No indexed repository is called "${repo}". Use the document id from a search result, or browse_repository to find the repository's name.`,
        );
    }

    private safeKeyOrUndefined(key: string): string | undefined {
        try {
            return this.sanitize(key);
        } catch {
            return undefined;
        }
    }

    /** A relative key, with the `.md` the pipeline appends to every document, and no way out of the prefix. */
    private sanitize(key: string): string {
        const cleaned = key.replace(/^\.?\/+/, "").replace(/\\/g, "/");
        if (!cleaned) throw new Error("A document reference is required.");
        if (cleaned.split("/").some((segment) => segment === "..")) {
            throw new Error(`"${key}" is not a document reference.`);
        }
        return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
    }

    private async fetch(key: string): Promise<string> {
        try {
            return (await this.s3.getObject(key)).toString("utf8");
        } catch (err) {
            // A source file that is itself Markdown lives at "<path>.md.md", and the agent will
            // reasonably ask for "<path>.md". One more try before giving up.
            if (isNotFound(err) && this.sourcePathOf(key) && !key.endsWith(".md.md")) {
                try {
                    return (await this.s3.getObject(`${key}.md`)).toString("utf8");
                } catch {
                    // Fall through to the original error, which names the key that was asked for.
                }
            }
            if (isNotFound(err)) {
                throw new Error(
                    `There is no document at "${key}". Use the id a search result or a repository listing gave you.`,
                );
            }
            // Whatever else went wrong stays in the log: the raw error names the bucket and full key,
            // and what the agent is told ends up in the model's context and possibly in the answer.
            logger.warn(`Could not read ${key}: ${(err as Error).message}`);
            throw new Error(`The document at "${key}" could not be read right now.`);
        }
    }

    /** `<project>/bitbucket/<folder>/<path>.md` → `<path>`; undefined for anything else. */
    private sourcePathOf(key: string): string | undefined {
        const segments = key.split("/");
        if (segments.length < 4 || segments[1] !== CODE_CATEGORY) return undefined;
        const path = segments.slice(3).join("/").replace(/\.md$/, "");
        return isRepositoryIndexDocument(path) ? undefined : path;
    }

    /**
     * The pipeline writes a source file as a header table, a "## Source" heading and the file
     * inside a fence long enough that nothing in the file can close it. Finding that fence is
     * what lets the lines be numbered as the file's own.
     */
    private splitCodeDocument(text: string): CodeDocument | undefined {
        const lines = text.split("\n");
        const heading = lines.findIndex((line) => /^## Source\s*$/.test(line));
        if (heading < 0) return undefined;
        const open = lines.findIndex((line, index) => index > heading && /^`{3,}\S*\s*$/.test(line));
        if (open < 0) return undefined;
        const ticks = /^`+/.exec(lines[open])![0];
        let close = lines.length - 1;
        while (close > open && lines[close].trim() !== ticks) close -= 1;
        if (close <= open) return undefined;
        return { header: lines.slice(0, heading).join("\n").trim(), sourceLines: lines.slice(open + 1, close) };
    }

    private renderCode(code: CodeDocument, path: string, range: ReadRange): string {
        const total = code.sourceLines.length;
        const start = Math.max(1, Math.floor(range.startLine ?? 1));
        const end = Math.min(total, Math.floor(range.endLine ?? total));
        if (start > total) {
            return `${code.header}\n\n${path} has ${total} line(s); there is no line ${start}.`;
        }

        const width = String(end).length;
        const rendered: string[] = [];
        let used = 0;
        let last = start - 1;
        for (let line = start; line <= end; line += 1) {
            const numbered = `${String(line).padStart(width)} | ${code.sourceLines[line - 1]}`;
            if (used + numbered.length + 1 > MAX_READ_CHARS && rendered.length > 0) break;
            rendered.push(numbered);
            used += numbered.length + 1;
            last = line;
        }

        const remaining = total - last;
        const trailer =
            remaining > 0
                ? `\n\n(${remaining} more line(s); call read_document again with startLine=${last + 1} to continue.)`
                : "";
        return `${code.header}\n\nSource lines ${start}–${last} of ${total} (${path}):\n\n${rendered.join("\n")}${trailer}`;
    }

    private renderProse(text: string, range: ReadRange): string {
        const lines = text.split("\n");
        const total = lines.length;
        const start = Math.max(1, Math.floor(range.startLine ?? 1));
        const end = Math.min(total, Math.floor(range.endLine ?? total));
        if (start > total) return `The document has ${total} line(s); there is no line ${start}.`;

        const rendered: string[] = [];
        let used = 0;
        let last = start - 1;
        for (let line = start; line <= end; line += 1) {
            const current = lines[line - 1];
            if (used + current.length + 1 > MAX_READ_CHARS && rendered.length > 0) break;
            rendered.push(current);
            used += current.length + 1;
            last = line;
        }

        const partial = start > 1 || last < total;
        const note = partial ? `(Lines ${start}–${last} of ${total}.)\n\n` : "";
        const remaining = total - last;
        const trailer =
            remaining > 0
                ? `\n\n(${remaining} more line(s); call read_document again with startLine=${last + 1} to continue.)`
                : "";
        return `${note}${rendered.join("\n")}${trailer}`;
    }

    /** The document's headings, which the identifier guard should treat as names the agent saw. */
    private titlesIn(text: string): string[] {
        return text
            .split("\n")
            .filter((line) => /^#{1,2}\s+\S/.test(line))
            .slice(0, 50)
            .map((line) => line.replace(/^#+\s+/, "").trim());
    }
}
