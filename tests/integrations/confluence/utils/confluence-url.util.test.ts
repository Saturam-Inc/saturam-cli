import { parseConfluenceUrl } from "../../../../src/integrations/confluence/utils/confluence-url.util";

describe("parseConfluenceUrl", () => {
    it("should parse /wiki/spaces/<KEY>/pages/<id> URL", () => {
        const result = parseConfluenceUrl("https://example.atlassian.net/wiki/spaces/ENG/pages/123456");
        expect(result).toEqual({ baseUrl: "https://example.atlassian.net", pageId: "123456" });
    });

    it("should parse legacy ?pageId=<id> query-param URL", () => {
        const result = parseConfluenceUrl("https://example.atlassian.net/pages/viewpage.action?pageId=654321");
        expect(result).toEqual({ baseUrl: "https://example.atlassian.net", pageId: "654321" });
    });

    it("should parse /pages/<id> short form", () => {
        const result = parseConfluenceUrl("https://example.atlassian.net/pages/999");
        expect(result).toEqual({ baseUrl: "https://example.atlassian.net", pageId: "999" });
    });

    it("should return null for a non-Confluence URL", () => {
        expect(parseConfluenceUrl("https://example.com/something/else")).toBeNull();
    });

    it("should return null for a Jira URL", () => {
        expect(parseConfluenceUrl("https://example.atlassian.net/browse/PROJ-123")).toBeNull();
    });

    it("should return null for a plain string that is not a URL", () => {
        expect(parseConfluenceUrl("not-a-url")).toBeNull();
    });

    it("should extract baseUrl origin correctly from a subdomain URL", () => {
        const result = parseConfluenceUrl("https://myteam.atlassian.net/wiki/spaces/DEV/pages/42/Page+Title");
        expect(result?.baseUrl).toBe("https://myteam.atlassian.net");
        expect(result?.pageId).toBe("42");
    });

    it("should preserve a Server/Data Center context path in baseUrl (?pageId= form)", () => {
        const result = parseConfluenceUrl("https://company.com/confluence/pages/viewpage.action?pageId=123");
        expect(result).toEqual({ baseUrl: "https://company.com/confluence", pageId: "123" });
    });

    it("should preserve a Server/Data Center context path in baseUrl (/wiki/spaces form)", () => {
        const result = parseConfluenceUrl("https://company.com/confluence/wiki/spaces/DEV/pages/42");
        expect(result).toEqual({ baseUrl: "https://company.com/confluence", pageId: "42" });
    });
});
