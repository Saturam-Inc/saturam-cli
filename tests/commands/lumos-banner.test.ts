import { BANNER_HEADLINE, BANNER_TAGLINE, BANNER_WIDTH, renderLumosBanner } from "../../src/commands/lumos-banner";

/** The banner is coloured; the shape is what these check. */
const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

describe("Lumos banner", () => {
    it("frames LUMOS in block letters with the wordmark and tagline beneath, every line the same width", () => {
        const lines = renderLumosBanner(100).map(plain);

        const framed = lines.filter((line) => /[│╭╰]/.test(line));
        expect(framed[0]).toMatch(/^ {2}╭─+╮$/);
        expect(framed[framed.length - 1]).toMatch(/^ {2}╰─+╯$/);
        expect(new Set(framed.map((line) => line.length))).toEqual(new Set([2 + BANNER_WIDTH]));

        // The last row of the letters is all shadow, so it has no solid block in it.
        expect(lines.filter((line) => /[█╚]/.test(line))).toHaveLength(6);
        expect(lines.some((line) => line.includes("E N G I N E E R I N G   I N T E L L I G E N C E"))).toBe(true);
        expect(lines.some((line) => line.includes(BANNER_TAGLINE))).toBe(true);
    });

    it("falls back to one line where the frame would wrap", () => {
        const lines = renderLumosBanner(50).map(plain);

        expect(lines.some((line) => /[│█]/.test(line))).toBe(false);
        expect(lines.join("\n")).toContain(`LUMOS · ${BANNER_HEADLINE}`);
    });

    it("fits an 80-column terminal with its margin", () => {
        expect(2 + BANNER_WIDTH).toBeLessThanOrEqual(80);
    });
});
