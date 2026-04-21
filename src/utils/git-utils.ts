export const BASE_DIFF_EXCLUSIONS = [
    "*.lock",
    "*.lockb",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.snap",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.svg",
    "*.ico",
    "*.woff",
    "*.woff2",
    "*.ttf",
    "*.eot",
];

export const VENDORED_CODE_PATTERNS = ["vendor/**", "third_party/**", "node_modules/**", ".git/**"];

export function parseDiffByFile(rawDiff: string): Record<string, string> {
    const chunks: Record<string, string> = {};
    const diffRegex = /^diff --git a\/(.+?) b\//gm;
    let match: RegExpExecArray | null;
    const positions: { file: string; start: number }[] = [];

    while ((match = diffRegex.exec(rawDiff)) !== null) {
        positions.push({ file: match[1], start: match.index });
    }

    for (let i = 0; i < positions.length; i++) {
        const end = i + 1 < positions.length ? positions[i + 1].start : rawDiff.length;
        chunks[positions[i].file] = rawDiff.slice(positions[i].start, end);
    }

    return chunks;
}
