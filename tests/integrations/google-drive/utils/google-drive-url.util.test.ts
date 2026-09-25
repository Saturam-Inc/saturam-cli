import {
    parseGoogleDocUrl,
    parseGoogleSheetUrl,
} from "../../../../src/integrations/google-drive/utils/google-drive-url.util";

describe("parseGoogleDocUrl", () => {
    it("should parse a standard Google Docs edit URL", () => {
        const result = parseGoogleDocUrl("https://docs.google.com/document/d/abc123XYZ/edit");
        expect(result).toBe("abc123XYZ");
    });

    it("should parse a Google Docs view URL", () => {
        const result = parseGoogleDocUrl("https://docs.google.com/document/d/def456/view");
        expect(result).toBe("def456");
    });

    it("should return null for a non-Docs URL", () => {
        expect(parseGoogleDocUrl("https://example.com/doc/abc123")).toBeNull();
    });

    it("should return null for a Google Sheets URL", () => {
        expect(parseGoogleDocUrl("https://docs.google.com/spreadsheets/d/sheet123/edit")).toBeNull();
    });

    it("should return null for a plain string", () => {
        expect(parseGoogleDocUrl("abc123XYZ")).toBeNull();
    });

    it("should return null for an invalid URL", () => {
        expect(parseGoogleDocUrl("not-a-url")).toBeNull();
    });
});

describe("parseGoogleSheetUrl", () => {
    it("should parse a standard Google Sheets edit URL", () => {
        const result = parseGoogleSheetUrl("https://docs.google.com/spreadsheets/d/sheet123ABC/edit");
        expect(result).toBe("sheet123ABC");
    });

    it("should parse a Google Sheets URL without trailing path", () => {
        const result = parseGoogleSheetUrl("https://docs.google.com/spreadsheets/d/xyz789");
        expect(result).toBe("xyz789");
    });

    it("should return null for a Google Docs URL", () => {
        expect(parseGoogleSheetUrl("https://docs.google.com/document/d/abc123/edit")).toBeNull();
    });

    it("should return null for a non-Google URL", () => {
        expect(parseGoogleSheetUrl("https://example.com/spreadsheets/d/foo")).toBeNull();
    });

    it("should return null for a plain string", () => {
        expect(parseGoogleSheetUrl("sheet123ABC")).toBeNull();
    });
});
