import { OnboardCommand } from "../../src/commands/onboard-command";

jest.mock("@inquirer/prompts", () => ({ input: jest.fn(), select: jest.fn() }));

describe("stripInlineCitations", () => {
    const strip = (text: string): string => (OnboardCommand.prototype as any).stripInlineCitations.call({}, text);

    it("removes citation markers from prose", () => {
        expect(strip("The sync copies documents. [1]")).toBe("The sync copies documents.");
        expect(strip("Both paths apply [1, 2] to the diff.")).toBe("Both paths apply to the diff.");
    });

    it("leaves array indices in fenced code untouched", () => {
        // The bug this guards: "x[1]" became "x", silently producing a wrong code example.
        const code = "```python\nsorted(data, key=lambda x: x[1])\n```";
        expect(strip(code)).toBe(code);
    });

    it("leaves list literals in fenced code untouched", () => {
        const code = "```python\nnums = [1, 2, 3]\n```";
        expect(strip(code)).toBe(code);
    });

    it("leaves indices in inline code untouched", () => {
        expect(strip("Use `row[1]` for the value.")).toBe("Use `row[1]` for the value.");
    });

    it("keeps an index attached to an identifier even outside a code span", () => {
        expect(strip("Read chunks[0] first.")).toBe("Read chunks[0] first.");
        expect(strip("Call fn()[1] to unwrap.")).toBe("Call fn()[1] to unwrap.");
    });

    it("strips prose citations while preserving code in the same answer", () => {
        const input = "The loader indexes rows. [1]\n\n```js\nconst first = rows[0];\n```\n\nThat is all. [2]";
        expect(strip(input)).toBe("The loader indexes rows.\n\n```js\nconst first = rows[0];\n```\n\nThat is all.");
    });
});
