import { getLogger } from "log4js";
import { Service } from "typedi";
import * as mammoth from "mammoth";
import { GoogleDriveService } from "../../integrations/google-drive/services/google-drive.service";
import { HtmlNormalizerService } from "../normalizers/html-normalizer.service";
import { KnowledgeDocument, KnowledgeSource } from "./knowledge-source.model";

const logger = getLogger("GoogleDriveKnowledgeSource");

const NATIVE_DOC_MIME = "application/vnd.google-apps.document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Adapter that maps a Google Drive file (native Doc or DOCX) into a KnowledgeDocument.
 * This class owns the fetch → normalize → KnowledgeDocument mapping.
 *
 * Supported file types:
 *   - Native Google Docs (exported directly as Markdown)
 *   - Word .docx files (downloaded as binary, parsed via mammoth, converted to Markdown)
 *
 * Any feature that needs "a Google Drive document as a KnowledgeDocument" (onboarding, indexing, ask)
 * should call this adapter.
 */
@Service()
export class GoogleDriveKnowledgeSource implements KnowledgeSource {
    constructor(
        private readonly googleDrive: GoogleDriveService,
        private readonly html: HtmlNormalizerService,
    ) { }

    public async fetch(
        id: string,
        _options?: Record<string, unknown>,
    ): Promise<KnowledgeDocument> {
        if (!id) {
            throw new Error("Google Document ID is missing or invalid.");
        }

        logger.info(`Fetching Google Drive document ${id}...`);

        // 1. Fetch raw metadata to get title and mimeType
        const metadata = await this.googleDrive.getFileMetadata(id);
        const title = metadata.name ?? id;
        const mimeType = metadata.mimeType ?? "";

        // 2. Fetch content — route based on mimeType
        const markdownContent = await (async () => {
            if (mimeType === NATIVE_DOC_MIME) {
                // Native Google Doc: Drive exports Markdown directly
                return await this.googleDrive.exportGoogleDocAsMarkdown(id);
            } else if (mimeType === DOCX_MIME) {
                // File size limit check (50MB)
                const sizeBytes = parseInt(metadata.size ?? "0", 10);
                const MAX_BYTES = 50 * 1024 * 1024;
                if (sizeBytes > MAX_BYTES) {
                    throw new Error(
                        `File "${title}" (${id}) is ${Math.round(sizeBytes / 1024 / 1024)}MB, exceeding the 50MB limit.`,
                    );
                }

                // Non-native Word docx: download raw binary, parse via mammoth, convert HTML → Markdown
                logger.info(`Downloading binary Word document (${title}) and parsing locally...`);
                const arrayBuffer = await this.googleDrive.getFileBinary(id);
                const buffer = Buffer.from(arrayBuffer);

                // ZIP magic check (DOCX files are ZIP archives starting with PK)
                if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
                    throw new Error(`File "${id}" does not appear to be a valid DOCX (invalid ZIP header)`);
                }

                const result = await mammoth.convertToHtml({ buffer });
                if (result.messages && result.messages.length > 0) {
                    logger.warn(
                        `Mammoth conversion warnings for document "${title}" (${id}): ${JSON.stringify(
                            result.messages,
                        )}`,
                    );
                }
                return this.html.convertHtmlToMarkdown(result.value);
            } else {
                throw new Error(
                    `Unsupported file type: ${mimeType || "unknown"}. Only native Google Docs or Word .docx files are supported.`,
                );
            }
        })();

        if (!markdownContent) {
            logger.warn(`Fetched Google Drive document ${id} ("${title}") contains no content.`);
        }

        const docUrl = `https://docs.google.com/document/d/${id}/edit`;

        // 3. Return KnowledgeDocument
        return {
            id,
            source: "googleDocs",
            title,
            content: markdownContent || "",
            url: docUrl,
            metadata: {
                updatedAt: metadata.modifiedTime,
                author: metadata.owners?.[0]?.displayName,
                labels: [],
            },
        };
    }
}
