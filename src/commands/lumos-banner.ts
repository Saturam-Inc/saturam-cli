import * as colors from "yoctocolors-cjs";

/**
 * The welcome banner for the chat: "LUMOS" in block letters inside a frame, with the wordmark
 * beneath. Drawn by hand so it costs no dependency. The solid blocks are each letter's lit face
 * and the box-drawing strokes its shadow, which is the one bit of theatre the name asks for.
 */
const ROWS = [
    "██╗     ██╗   ██╗███╗   ███╗ ██████╗ ███████╗",
    "██║     ██║   ██║████╗ ████║██╔═══██╗██╔════╝",
    "██║     ██║   ██║██╔████╔██║██║   ██║███████╗",
    "██║     ██║   ██║██║╚██╔╝██║██║   ██║╚════██║",
    "███████╗╚██████╔╝██║ ╚═╝ ██║╚██████╔╝███████║",
    "╚══════╝ ╚═════╝ ╚═╝     ╚═╝ ╚═════╝ ╚══════╝",
];

const ART_WIDTH = ROWS[0].length;
/** Room between the letters and the frame on each side. */
const INSET = 8;
const INNER_WIDTH = ART_WIDTH + INSET * 2;
/** The frame's full width, borders included; it is drawn behind MARGIN. */
export const BANNER_WIDTH = INNER_WIDTH + 2;
const MARGIN = "  ";

export const BANNER_HEADLINE = "Engineering Intelligence";
export const BANNER_TAGLINE = "Ask the architecture. Trace the code. Plan the change.";

/** Letter-spaced, the way a wordmark is set under a logo. */
function spaced(text: string): string {
    return text.toUpperCase().split("").join(" ");
}

const edge = (glyph: string): string => colors.gray(glyph);

/** The solid blocks are the lit face of each letter, the box-drawing strokes its shadow. */
const lit = (row: string): string =>
    row.replace(/█+|[^█]+/g, (run) => (run.startsWith("█") ? colors.yellow(run) : colors.gray(run)));

/**
 * One line of the frame: `content` centred in the inner width as plain text, then painted,
 * so the padding is not thrown off by the colour codes.
 */
function framed(content: string, paint: (text: string) => string = (text) => text): string {
    const left = Math.floor((INNER_WIDTH - content.length) / 2);
    const right = INNER_WIDTH - content.length - left;
    return `${MARGIN}${edge("│")}${" ".repeat(left)}${paint(content)}${" ".repeat(right)}${edge("│")}`;
}

/**
 * The banner as lines to print, sized to the terminal: the framed letters where they fit,
 * one line where they would wrap into noise.
 */
export function renderLumosBanner(columns: number): string[] {
    if (columns < MARGIN.length + BANNER_WIDTH) {
        return ["", `${MARGIN}${colors.bold(colors.yellow("LUMOS"))} ${colors.dim("·")} ${BANNER_HEADLINE}`, ""];
    }
    return [
        "",
        `${MARGIN}${edge(`╭${"─".repeat(INNER_WIDTH)}╮`)}`,
        framed(""),
        ...ROWS.map((row) => framed(row, lit)),
        framed(""),
        framed(spaced(BANNER_HEADLINE), (text) => colors.bold(colors.yellow(text))),
        framed(BANNER_TAGLINE),
        framed(""),
        `${MARGIN}${edge(`╰${"─".repeat(INNER_WIDTH)}╯`)}`,
        "",
    ];
}
