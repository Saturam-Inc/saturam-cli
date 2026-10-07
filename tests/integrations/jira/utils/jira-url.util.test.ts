import { parseJiraUrl } from "../../../../src/integrations/jira/utils/jira-url.util";

describe("parseJiraUrl", () => {
    it("should parse /browse/<KEY-ID> URL", () => {
        const result = parseJiraUrl("https://example.atlassian.net/browse/PROJ-123");
        expect(result).toEqual({ baseUrl: "https://example.atlassian.net", ticketKey: "PROJ-123" });
    });

    it("should parse /issues/<KEY-ID> URL", () => {
        const result = parseJiraUrl("https://example.atlassian.net/issues/MYAPP-456");
        expect(result).toEqual({ baseUrl: "https://example.atlassian.net", ticketKey: "MYAPP-456" });
    });

    it("should normalize ticket key to uppercase", () => {
        const result = parseJiraUrl("https://jira.example.com/browse/proj-99");
        expect(result?.ticketKey).toBe("PROJ-99");
    });

    it("should return null for a non-Jira URL", () => {
        expect(parseJiraUrl("https://confluence.example.com/wiki/spaces/ENG/pages/123")).toBeNull();
    });

    it("should return null for a plain string", () => {
        expect(parseJiraUrl("PROJ-123")).toBeNull();
    });

    it("should return null for an invalid URL", () => {
        expect(parseJiraUrl("not-a-url")).toBeNull();
    });

    it("should extract baseUrl origin correctly", () => {
        const result = parseJiraUrl("https://myteam.atlassian.net/browse/ENG-7/details");
        expect(result?.baseUrl).toBe("https://myteam.atlassian.net");
        expect(result?.ticketKey).toBe("ENG-7");
    });

    it("should preserve a Server/Data Center context path in baseUrl", () => {
        const result = parseJiraUrl("https://company.com/jira/browse/PROJ-123");
        expect(result).toEqual({ baseUrl: "https://company.com/jira", ticketKey: "PROJ-123" });
    });
});
