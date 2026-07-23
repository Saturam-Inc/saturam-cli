import { AdfNormalizerService } from "../../../src/services/normalizers/adf-normalizer.service";

describe("AdfNormalizerService", () => {
    let adfNormalizer: AdfNormalizerService;

    beforeEach(() => {
        adfNormalizer = new AdfNormalizerService();
    });

    describe("renderAdfNode", () => {
        it("should render plain paragraph text", () => {
            const adf = {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: "Hello Jira!" }],
                    },
                ],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toBe("Hello Jira!\n");
        });

        it("should render heading level 1 and 2", () => {
            const adf = {
                type: "doc",
                content: [
                    {
                        type: "heading",
                        attrs: { level: 1 },
                        content: [{ type: "text", text: "Main Title" }],
                    },
                    {
                        type: "heading",
                        attrs: { level: 2 },
                        content: [{ type: "text", text: "Sub Section" }],
                    },
                ],
            };
            const md = adfNormalizer.renderAdfNode(adf);
            expect(md).toContain("# Main Title");
            expect(md).toContain("## Sub Section");
        });

        it("should render bold, italic, code, strike, and link marks", () => {
            const adf = {
                type: "paragraph",
                content: [
                    { type: "text", text: "bold text", marks: [{ type: "strong" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "italic text", marks: [{ type: "em" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "inline code", marks: [{ type: "code" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "strikeout", marks: [{ type: "strike" }] },
                    { type: "text", text: " " },
                    {
                        type: "text",
                        text: "Jira link",
                        marks: [{ type: "link", attrs: { href: "https://atlassian.com" } }],
                    },
                ],
            };
            const md = adfNormalizer.renderAdfNode(adf);
            expect(md).toContain("**bold text**");
            expect(md).toContain("*italic text*");
            expect(md).toContain("`inline code`");
            expect(md).toContain("~~strikeout~~");
            expect(md).toContain("[Jira link](https://atlassian.com)");
        });

        it("should render bullet lists", () => {
            const adf = {
                type: "bulletList",
                content: [
                    {
                        type: "listItem",
                        content: [
                            { type: "paragraph", content: [{ type: "text", text: "Bullet Item One" }] },
                        ],
                    },
                ],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toContain("- Bullet Item One");
        });

        it("should render ordered lists with sequential numbering", () => {
            const adf = {
                type: "orderedList",
                content: [
                    {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Step One" }] }],
                    },
                    {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Step Two" }] }],
                    },
                ],
            };
            const md = adfNormalizer.renderAdfNode(adf);
            expect(md).toContain("1. Step One");
            expect(md).toContain("2. Step Two");
        });

        it("should render code blocks", () => {
            const adf = {
                type: "codeBlock",
                attrs: { language: "typescript" },
                content: [{ type: "text", text: "const x = 123;" }],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toContain("```typescript\nconst x = 123;\n```");
        });

        it("should render blockquotes", () => {
            const adf = {
                type: "blockquote",
                content: [
                    { type: "paragraph", content: [{ type: "text", text: "Important notice." }] },
                ],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toContain("> Important notice.");
        });
    });
});
