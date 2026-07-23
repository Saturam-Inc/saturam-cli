import { GoogleDriveKnowledgeSource } from "../../../src/services/knowledge/google-drive-knowledge.source";
import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";
import { HtmlNormalizerService } from "../../../src/services/normalizers/html-normalizer.service";

jest.mock("mammoth", () => ({
    convertToHtml: jest.fn().mockResolvedValue({ value: "<p>DOCX content here</p>" }),
}));

describe("GoogleDriveKnowledgeSource", () => {
    let source: GoogleDriveKnowledgeSource;
    let mockGoogleDrive: jest.Mocked<GoogleDriveService>;
    let html: HtmlNormalizerService;

    beforeEach(() => {
        mockGoogleDrive = {
            getFileMetadata: jest.fn(),
            exportGoogleDocAsMarkdown: jest.fn(),
            getFileBinary: jest.fn(),
        } as any;
        html = new HtmlNormalizerService();
        source = new GoogleDriveKnowledgeSource(mockGoogleDrive, html);
    });

    it("should fetch native Google Doc and return KnowledgeDocument", async () => {
        mockGoogleDrive.getFileMetadata.mockResolvedValue({
            name: "My Spec",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-07-10T00:00:00Z",
            owners: [{ displayName: "Eve" }],
        } as any);
        mockGoogleDrive.exportGoogleDocAsMarkdown.mockResolvedValue("# My Spec\nSome content.");

        const doc = await source.fetch("doc-id-abc");

        expect(doc.id).toBe("doc-id-abc");
        expect(doc.source).toBe("googleDocs");
        expect(doc.title).toBe("My Spec");
        expect(doc.content).toBe("# My Spec\nSome content.");
        expect(doc.url).toBe("https://docs.google.com/document/d/doc-id-abc/edit");
        expect(doc.metadata.author).toBe("Eve");
        expect(doc.metadata.updatedAt).toBe("2026-07-10T00:00:00Z");
        expect(mockGoogleDrive.exportGoogleDocAsMarkdown).toHaveBeenCalledWith("doc-id-abc");
    });

    it("should download and parse DOCX via mammoth", async () => {
        mockGoogleDrive.getFileMetadata.mockResolvedValue({
            name: "Report.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            modifiedTime: "2026-07-11T00:00:00Z",
            owners: [],
        } as any);
        const ab = new ArrayBuffer(8);
        const view = new Uint8Array(ab);
        view[0] = 0x50;
        view[1] = 0x4B;
        mockGoogleDrive.getFileBinary.mockResolvedValue(ab);

        const doc = await source.fetch("docx-id-xyz");

        expect(doc.title).toBe("Report.docx");
        expect(doc.content).toContain("DOCX content here"); // mammoth mock → html → normalizer
        expect(mockGoogleDrive.getFileBinary).toHaveBeenCalledWith("docx-id-xyz");
    });

    it("should throw if DOCX file size exceeds 50MB", async () => {
        mockGoogleDrive.getFileMetadata.mockResolvedValue({
            name: "Huge.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: (51 * 1024 * 1024).toString(),
        } as any);

        await expect(source.fetch("huge-id")).rejects.toThrow("exceeding the 50MB limit");
    });

    it("should throw if DOCX file does not have a valid ZIP magic header", async () => {
        mockGoogleDrive.getFileMetadata.mockResolvedValue({
            name: "Invalid.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: "1024",
        } as any);
        // All zeros array buffer (no PK header)
        mockGoogleDrive.getFileBinary.mockResolvedValue(new ArrayBuffer(8));

        await expect(source.fetch("invalid-id")).rejects.toThrow("does not appear to be a valid DOCX");
    });

    it("should throw for unsupported mime types", async () => {
        mockGoogleDrive.getFileMetadata.mockResolvedValue({
            name: "image.png",
            mimeType: "image/png",
            modifiedTime: "2026-07-01T00:00:00Z",
            owners: [],
        } as any);

        await expect(source.fetch("img-id")).rejects.toThrow("Unsupported file type");
    });

    it("should throw if id is missing", async () => {
        await expect(source.fetch("")).rejects.toThrow("Google Document ID is missing or invalid.");
    });
});
