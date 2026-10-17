/**
 * The onboarding document set the Lumos documentation standard defines: numbered guides under
 * `docs/onboarding/`, each with a fixed slot. The numbers never change meaning, which is what lets
 * the mentor open "the architecture guide" of any project by name instead of hoping a similarity
 * search ranks it first. A set kept in Drive is indexed under the same titles, so the names below
 * also find those.
 */
export const GUIDE_DIRECTORY = "docs/onboarding/";

export interface GuideTopic {
    /** Two-digit slot, as the file name starts. */
    number: string;
    /** The file's slug after the number: `03-architecture.md` → `architecture`. */
    slug: string;
    /** One line the agent reads to decide whether it needs this guide. */
    holds: string;
}

export const GUIDE_TOPICS: readonly GuideTopic[] = [
    { number: "00", slug: "overview", holds: "what the project is, its parts, status, owners, the document list" },
    { number: "01", slug: "tech-stack", holds: "languages, frameworks, runtimes, infrastructure, with versions" },
    { number: "02", slug: "repository-map", holds: "every top-level directory and key file, with entry points" },
    {
        number: "03",
        slug: "architecture",
        holds: "components, how they communicate, the flow end to end, where it runs",
    },
    { number: "04", slug: "running-locally", holds: "setup, run, seed data, the failures newcomers hit" },
    { number: "05", slug: "backend", holds: "services and modules, endpoints, workers, what each owns" },
    { number: "06", slug: "frontend", holds: "client applications: structure, state, how they call services" },
    { number: "07", slug: "screens-and-metrics", holds: "each screen or command and the data behind it" },
    { number: "08", slug: "data-model", holds: "tables, schemas, datasets: fields, keys, producers, consumers" },
    { number: "09", slug: "data-lineage", holds: "sources to outputs, per domain or dataset" },
    { number: "10", slug: "transformations", holds: "each processing step: input, logic, output, file and function" },
    { number: "11", slug: "metrics", holds: "each metric: definition, formula, source, where computed" },
    {
        number: "12",
        slug: "pipelines",
        holds: "each job: trigger, reads, writes, order, dependencies, failure behaviour",
    },
    { number: "13", slug: "data-quality", holds: "checks and validations, where, what they catch, the gaps" },
    { number: "14", slug: "testing", holds: "how to run the tests, what they cover, how CI runs them" },
    { number: "15", slug: "integrations", holds: "each external system: direction, protocol, auth, failure modes" },
    { number: "16", slug: "configuration", holds: "every config key, env var and flag: where read, default, effect" },
    { number: "17", slug: "deployment", holds: "how it is built, shipped and run per environment, and rolled back" },
    { number: "18", slug: "operations", holds: "monitoring, logs, alerts, routine tasks, what to do when it breaks" },
    {
        number: "19",
        slug: "known-issues",
        holds: "bugs, gaps, debt and security findings, with the file that shows each",
    },
    { number: "20", slug: "glossary", holds: "internal terms and acronyms" },
    { number: "21", slug: "open-questions", holds: "what the code could not answer, and who could" },
    {
        number: "23",
        slug: "making-changes",
        holds: "recipes: each common change with exact files, steps, verification",
    },
    { number: "24", slug: "dependencies", holds: "module, system, data and job dependencies" },
    {
        number: "25",
        slug: "change-impact-map",
        holds: "one row per entity: defined in, read by, written by, what to check before changing",
    },
    { number: "26", slug: "security-and-access", holds: "authentication, authorisation, where secrets live by name" },
    { number: "27", slug: "infrastructure", holds: "each cloud resource: type, name, IaC file, what it depends on" },
    { number: "28", slug: "interfaces-and-events", holds: "API, event and message contracts, queues, versioning" },
    { number: "29", slug: "models", holds: "each ML model: training, data, evaluation, serving, retraining" },
    { number: "30", slug: "conventions", holds: "naming, folder rules, error handling, logging, review conventions" },
    { number: "31", slug: "decisions", holds: "decisions that shaped the project and the reason for each" },
];

/** Other names people and models use for a slot. */
const ALIASES: Record<string, string> = {
    arch: "architecture",
    design: "architecture",
    "system-design": "architecture",
    stack: "tech-stack",
    "repo-map": "repository-map",
    layout: "repository-map",
    setup: "running-locally",
    local: "running-locally",
    screens: "screens-and-metrics",
    schema: "data-model",
    tables: "data-model",
    lineage: "data-lineage",
    jobs: "pipelines",
    dags: "pipelines",
    schedules: "pipelines",
    workflows: "pipelines",
    quality: "data-quality",
    tests: "testing",
    config: "configuration",
    settings: "configuration",
    env: "configuration",
    deploy: "deployment",
    release: "deployment",
    ops: "operations",
    runbook: "operations",
    monitoring: "operations",
    issues: "known-issues",
    bugs: "known-issues",
    terms: "glossary",
    questions: "open-questions",
    unknowns: "open-questions",
    changes: "making-changes",
    recipes: "making-changes",
    cookbook: "making-changes",
    deps: "dependencies",
    "impact-map": "change-impact-map",
    impact: "change-impact-map",
    "impact-analysis": "change-impact-map",
    security: "security-and-access",
    access: "security-and-access",
    auth: "security-and-access",
    infra: "infrastructure",
    cloud: "infrastructure",
    apis: "interfaces-and-events",
    events: "interfaces-and-events",
    interfaces: "interfaces-and-events",
    contracts: "interfaces-and-events",
    ml: "models",
    adr: "decisions",
    adrs: "decisions",
};

/** A guide found in a repository's index, as the pipeline indexed it. */
export interface GuideEntry {
    /** `docs/onboarding/03-architecture.md` */
    path: string;
    /** `03`, or `22a` for a deep dive. */
    number: string;
    /** `architecture` */
    slug: string;
}

const GUIDE_FILE = /^docs\/onboarding\/(\d{2}[a-z]?)-([^/]+)\.md$/i;

/** The guides among a repository's indexed paths, in reading order. */
export function guidesIn(paths: readonly string[]): GuideEntry[] {
    return paths
        .flatMap((path) => {
            const match = GUIDE_FILE.exec(path);
            return match ? [{ path, number: match[1].toLowerCase(), slug: match[2].toLowerCase() }] : [];
        })
        .sort((a, b) => a.number.localeCompare(b.number) || a.slug.localeCompare(b.slug));
}

/** What a topic asks for: `architecture`, `03`, `3`, `03-architecture`, `the impact map` all resolve to a slot. */
export function normalizeGuideTopic(topic: string): { number?: string; slug: string } {
    const cleaned = topic
        .trim()
        .toLowerCase()
        .replace(/\.md$/, "")
        .replace(/^docs\/onboarding\//, "")
        .replace(/\b(the|guide|doc|document|page)\b/g, " ")
        .trim()
        .replace(/[\s_]+/g, "-")
        .replace(/^-+|-+$/g, "");

    const numbered = /^(\d{1,2})([a-z]?)(?:-(.+))?$/.exec(cleaned);
    if (numbered) {
        const number = `${numbered[1].padStart(2, "0")}${numbered[2]}`;
        const known = GUIDE_TOPICS.find((candidate) => candidate.number === number);
        return { number, slug: numbered[3] ?? known?.slug ?? "" };
    }

    const slug = ALIASES[cleaned] ?? cleaned;
    const known = GUIDE_TOPICS.find((candidate) => candidate.slug === slug);
    return known ? { number: known.number, slug: known.slug } : { slug };
}

/** The entry a topic names: by number first, then by slug, then a deep dive whose slug contains the topic. */
export function matchGuide(
    entries: readonly GuideEntry[],
    wanted: { number?: string; slug: string },
): GuideEntry | undefined {
    if (wanted.number) {
        const byNumber = entries.find((entry) => entry.number === wanted.number);
        if (byNumber) return byNumber;
    }
    if (!wanted.slug) return undefined;
    return (
        entries.find((entry) => entry.slug === wanted.slug) ??
        entries.find((entry) => entry.slug.includes(wanted.slug) || wanted.slug.includes(entry.slug))
    );
}

/** The standard's one-line description of a slot, for listings; undefined for a deep dive. */
export function describeGuide(entry: GuideEntry): string | undefined {
    return GUIDE_TOPICS.find((topic) => topic.number === entry.number)?.holds;
}
