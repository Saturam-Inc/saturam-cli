/**
 * Slugifies a string: lowercases it and collapses runs of anything that isn't a Unicode letter
 * or digit into a single separator, trimming leading/trailing separators.
 *
 * Uses \p{L}/\p{N} (Unicode letter/number categories) rather than [a-z0-9] so non-ASCII names
 * (e.g. "日本語プロジェクト", "Café") keep their characters instead of collapsing to nothing.
 */
export function slugify(input: string, separator = "-"): string {
    return input
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, separator)
        .replace(new RegExp(`(^\\${separator}|\\${separator}$)`, "g"), "");
}
