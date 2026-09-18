import { getGroundingCheckMessages } from "../../src/prompts/grounding-check.prompt";

/** A synced Confluence document: generated metadata table first, real content after. */
function syncedDoc(title: string, body: string): string {
    return [
        `# ${title}`,
        "| Field | Value |",
        "| :- | :- |",
        "| **Space** | mrf |",
        "| **Version** | 3 |",
        "| **Author** | SathyaPrakash S |",
        "| **Updated** | 2025-02-24T07:05:24.030Z |",
        "| **Labels** | _none_ |",
        "| **Link** | [Open in Confluence](https://example.atlassian.net/wiki/x) |",
        "## Content",
        body,
    ].join("\n");
}

describe("grounding check prompt", () => {
    function judgeSees(content: string): string {
        const messages = getGroundingCheckMessages({
            question: "what tech stacks are used?",
            chunks: [{ content, metadata: { title: "Overall Flow", project: "mrf" } }],
        });
        return String(messages[1].content);
    }

    it("drops the generated metadata table so the judge reads actual content", () => {
        // The bug this guards: every document opens with this table, and the truncated excerpt
        // was all header — so documents that plainly answered the question read as unrelated.
        const seen = judgeSees(
            syncedDoc("Overall Flow", "The pipeline uses Azure Data Factory, Airflow and PostgreSQL."),
        );

        expect(seen).not.toContain("**Space**");
        expect(seen).not.toContain("**Author**");
        expect(seen).toContain("Azure Data Factory");
    });

    it("keeps enough of the document to reach content that follows a long preamble", () => {
        const body = `${"Background filler. ".repeat(40)}\nThe stack is DB2, ADF, Airflow and PostgreSQL.`;
        expect(judgeSees(syncedDoc("Overall Flow", body))).toContain("PostgreSQL");
    });

    it("falls back to the raw text when a chunk is nothing but a header", () => {
        const headerOnly = ["# Overall Flow", "| Field | Value |", "| **Space** | mrf |"].join("\n");

        expect(judgeSees(headerOnly)).toContain("Overall Flow");
    });

    it("handles a chunk that starts mid-document with no header at all", () => {
        expect(judgeSees("The pipeline runs on Airflow every Sunday.")).toContain("Airflow");
    });

    it("tells the judge its default verdict is sufficient", () => {
        const system = String(getGroundingCheckMessages({ question: "q", chunks: [{ content: "text" }] })[0].content);

        expect(system).toContain('default verdict is "sufficient"');
        expect(system).toContain("Lambda");
    });
});
