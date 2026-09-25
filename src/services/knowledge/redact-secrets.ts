/**
 * Last line of defence against a credential reaching the terminal.
 *
 * The answering prompts are told never to reproduce a key, token or password even when a document
 * shows one. This is the net under that rule for the models that will not reliably follow it. It
 * targets shapes that are unmistakably secrets — vendor key prefixes, bearer tokens, password
 * fields with a value, connection-string credentials — and leaves ordinary prose alone.
 *
 * It will not catch a low-entropy secret written as a plain word (a password that is a dictionary
 * word, a signing secret that is a product name). Those look like language, and matching them
 * would mean matching language. That gap is accepted; the prompt rule is what covers it.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
    // Vendor-prefixed keys: AWS access keys, OpenAI, GitLab, GitHub, Slack.
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => "[redacted]" },
    { pattern: /\b(?:sk|glpat|ghp|gho|ghs|xox[bap])-[A-Za-z0-9_\-]{16,}\b/g, replace: () => "[redacted]" },
    // Bearer tokens.
    { pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/g, replace: (_m, prefix) => `${prefix}[redacted]` },
    // Credentials inside connection strings: scheme://user:password@host
    {
        pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
        replace: (_m, prefix, _secret, suffix) => `${prefix}[redacted]${suffix}`,
    },
    // key = value pairs where the key names a secret and the value looks like one.
    {
        pattern:
            /\b([\w-]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)\s*[:=]\s*["']?)([^\s"',;)]{8,})(["']?)/gi,
        replace: (match, prefix, value, suffix) =>
            looksLikeSecretValue(value) ? `${prefix}[redacted]${suffix}` : match,
    },
];

/** Placeholders and code references that a key=value pattern would otherwise swallow. */
const PLACEHOLDER =
    /^(?:\$\{?\w+\}?|os\.environ.*|env\(.*|process\.env.*|<.*>|\.{3,}|x{4,}|your[_-].*|example.*|changeme|redacted|placeholder|none|null|undefined)$/i;

function looksLikeSecretValue(value: string): boolean {
    if (PLACEHOLDER.test(value)) return false;
    if (value.includes("(")) return false;
    // A real secret has entropy: a digit, or mixed case, or a long run of characters.
    return /\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || value.length >= 20;
}

export function redactSecrets(text: string): { text: string; redacted: number } {
    let redacted = 0;
    let output = text;
    for (const { pattern, replace } of SECRET_PATTERNS) {
        output = output.replace(pattern, (...args: string[]) => {
            const replacement = replace(args[0], ...args.slice(1));
            if (replacement !== args[0]) redacted += 1;
            return replacement;
        });
    }
    return { text: output, redacted };
}
