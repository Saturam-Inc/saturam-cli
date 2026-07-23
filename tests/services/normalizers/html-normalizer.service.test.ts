import { HtmlNormalizerService } from "../../../src/services/normalizers/html-normalizer.service";

describe("HtmlNormalizerService", () => {
    let normalizer: HtmlNormalizerService;

    beforeEach(() => {
        normalizer = new HtmlNormalizerService();
    });

    describe("convertHtmlToMarkdown", () => {
        it("should return empty string for empty input", () => {
            expect(normalizer.convertHtmlToMarkdown("")).toBe("");
        });

        it("should convert headings h1–h4", () => {
            const html = "<h1>Title</h1><h2>Section</h2><h3>Sub</h3><h4>Subsub</h4>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("# Title");
            expect(md).toContain("## Section");
            expect(md).toContain("### Sub");
            expect(md).toContain("#### Subsub");
        });

        it("should convert bold and italic", () => {
            const html = "<p><strong>bold</strong> and <em>italic</em></p>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("**bold**");
            expect(md).toContain("*italic*");
        });

        it("should convert <b> and <i> tags", () => {
            const html = "<b>boldB</b> <i>italicI</i>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("**boldB**");
            expect(md).toContain("*italicI*");
        });

        it("should convert strikethrough", () => {
            const html = "<strike>struck</strike> and <del>deleted</del>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("~~struck~~");
            expect(md).toContain("~~deleted~~");
        });

        it("should convert anchor links", () => {
            const html = '<a href="https://example.com">Click here</a>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("[Click here](https://example.com)");
        });

        it("should convert inline code", () => {
            const html = "<code>const x = 1;</code>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("`const x = 1;`");
        });

        it("should convert pre/code blocks to fenced code blocks", () => {
            const html = "<pre><code>function foo() {}</code></pre>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("```");
            expect(md).toContain("function foo() {}");
        });

        it("should convert <pre> without <code> to fenced block", () => {
            const html = "<pre>plain preformatted text</pre>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("```");
            expect(md).toContain("plain preformatted text");
        });

        it("should decode HTML entities", () => {
            const html = "&nbsp;&amp;&quot;&#39;&lt;&gt;";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("&");
            expect(md).toContain('"');
            expect(md).toContain("'");
            expect(md).toContain("<");
            expect(md).toContain(">");
        });

        it("should convert Confluence CDATA plain-text-body to fenced block", () => {
            const html = "<ac:plain-text-body><![CDATA[some code here]]></ac:plain-text-body>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("```");
            expect(md).toContain("some code here");
        });

        it("should strip Confluence structured-macro tags", () => {
            const html = "<ac:structured-macro ac:name=\"code\">content</ac:structured-macro>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).not.toContain("<ac:structured-macro");
        });

        it("should collapse excessive blank lines", () => {
            const html = "<p>First</p><p></p><p></p><p></p><p>Second</p>";
            const md = normalizer.convertHtmlToMarkdown(html);
            // Should not have more than 2 consecutive newlines
            expect(md).not.toMatch(/\n{3,}/);
        });

        it("should strip remaining HTML tags", () => {
            const html = "<div><span>Hello</span></div>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toBe("Hello");
        });
    });

    describe("table conversion", () => {
        it("should convert a simple HTML table to Markdown", () => {
            const html = `
                <table>
                    <tr><th>Name</th><th>Role</th></tr>
                    <tr><td>Alice</td><td>Engineer</td></tr>
                    <tr><td>Bob</td><td>Designer</td></tr>
                </table>`;
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("| Name | Role |");
            expect(md).toContain("| :--- | :--- |");
            expect(md).toContain("| Alice | Engineer |");
            expect(md).toContain("| Bob | Designer |");
        });
    });

    describe("list conversion", () => {
        it("should convert an unordered list", () => {
            const html = "<ul><li>Item A</li><li>Item B</li></ul>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("- Item A");
            expect(md).toContain("- Item B");
        });

        it("should convert an ordered list", () => {
            const html = "<ol><li>First</li><li>Second</li></ol>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("1. First");
            expect(md).toContain("1. Second");
        });

        it("should handle line breaks with <br>", () => {
            const html = "Line one<br>Line two";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("Line one");
            expect(md).toContain("Line two");
        });
    });
});
