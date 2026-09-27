import { markdownToMrkdwn, splitMrkdwn } from "../../src/slack/slack-mrkdwn";

describe("markdownToMrkdwn", () => {
    it("converts bold, italic, strikethrough and links to Slack's syntax", () => {
        expect(markdownToMrkdwn("**Bold**, *italic*, ~~gone~~ and [docs](https://x.io/a)")).toBe(
            "*Bold*, _italic_, ~gone~ and <https://x.io/a|docs>",
        );
    });

    it("turns headings into bold lines", () => {
        expect(markdownToMrkdwn("## How it **works**")).toBe("*How it works*");
    });

    it("turns bullets into bullet characters, keeping nesting", () => {
        expect(markdownToMrkdwn("- one\n  - nested\n* two")).toBe("• one\n    • nested\n• two");
    });

    it("escapes &, < and > everywhere, including code", () => {
        expect(markdownToMrkdwn("a < b & c > d\n```\nif (a < b) {}\n```")).toBe(
            "a &lt; b &amp; c &gt; d\n```\nif (a &lt; b) {}\n```",
        );
    });

    it("leaves code untouched apart from escaping — no formatting inside it", () => {
        expect(markdownToMrkdwn("Run `**not bold**` then\n```python\nx = a * b * c\n```")).toBe(
            "Run `**not bold**` then\n```\nx = a * b * c\n```",
        );
    });

    it("renders a table as an aligned code block", () => {
        const table = "| Name | Role |\n|------|------|\n| api | serves |\n| worker | runs jobs |";
        expect(markdownToMrkdwn(table)).toBe("```\nName    Role\napi     serves\nworker  runs jobs\n```");
    });

    it("drops links to anything that is not a web or mail address, keeping the text", () => {
        expect(markdownToMrkdwn("see [the file](./README.md)")).toBe("see the file");
    });

    it("closes a code block the answer left open", () => {
        expect(markdownToMrkdwn("```\ncode")).toBe("```\ncode\n```");
    });
});

describe("splitMrkdwn", () => {
    it("keeps short text in one piece", () => {
        expect(splitMrkdwn("short", 100)).toEqual(["short"]);
    });

    it("splits on paragraph boundaries and respects the limit", () => {
        const text = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
        const pieces = splitMrkdwn(text, 90);
        expect(pieces).toEqual([`${"a".repeat(40)}\n\n${"b".repeat(40)}`, "c".repeat(40)]);
        pieces.forEach((piece) => expect(piece.length).toBeLessThanOrEqual(90));
    });

    it("closes and reopens a code block cut across pieces, so each renders on its own", () => {
        const code = ["```", ...Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(10)}`), "```"].join("\n");
        const pieces = splitMrkdwn(code, 80);
        expect(pieces.length).toBeGreaterThan(1);
        for (const piece of pieces) {
            expect((piece.match(/^```/gm) ?? []).length % 2).toBe(0);
        }
    });

    it("hard-cuts a single line longer than the limit", () => {
        const pieces = splitMrkdwn("z".repeat(250), 100);
        expect(pieces.map((p) => p.length)).toEqual([100, 100, 50]);
    });
});
