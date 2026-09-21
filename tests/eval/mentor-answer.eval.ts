import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { getAllCommandsContainer } from "../../src/containers/all-commands";
import { AnswerFlowService, ProjectChooser } from "../../src/services/knowledge/answer-flow.service";
import { ConfigService } from "../../src/services/config-service";
import { StructuredOutputService } from "../../src/services/knowledge/structured-output";
import { JUDGE_SHAPE_HINT, RUBRIC_CRITERIA, getJudgeMessages } from "./judge.prompt";

/**
 * Scored eval for the mentor answering contract. Excluded from `pnpm test` (it makes real API
 * calls and needs a live Knowledge Base) — run it with `pnpm test:eval` before shipping prompt
 * changes, and compare the printed scores against the previous run.
 */

const JudgeSchema = z.object({
    answersQuestion: z.number().min(0).max(2),
    explainsWhy: z.number().min(0).max(2),
    definesJargon: z.number().min(0).max(2),
    pointsSomewhere: z.number().min(0).max(2),
    avoidsInvention: z.number().min(0).max(2),
    synthesizes: z.number().min(0).max(2),
    admitsGaps: z.number().min(0).max(2),
    avoidsTemplate: z.number().min(0).max(2),
    notes: z.string().default(""),
});

const QuestionSchema = z.object({
    id: z.string(),
    question: z.string(),
    /** Which behaviour the case exercises, so a regression points at one area rather than the mean. */
    group: z.enum(["descriptive", "scenario", "guardrail", "blended"]).default("descriptive"),
    notes: z.string().optional(),
    mustMention: z.array(z.string()).optional(),
});

const fixtures = z
    .object({ questions: z.array(QuestionSchema) })
    .parse(JSON.parse(readFileSync(join(__dirname, "fixtures", "mentor-questions.json"), "utf8")));

/** Minimum mean score per criterion, out of 2. Raise as the prompt improves. */
const PASS_THRESHOLD = 1.4;

/** Eval answers should not ask the user anything — always take the top candidate. */
const autoChooser: ProjectChooser = {
    async choose(_question, candidates) {
        return candidates[0] ? { kind: "project", slug: candidates[0].project.slug } : { kind: "all" };
    },
};

describe("mentor answering eval", () => {
    let flow: AnswerFlowService;
    let structured: StructuredOutputService;
    let enabled = false;

    beforeAll(async () => {
        const container = await getAllCommandsContainer(process.cwd());
        const config = container.get(ConfigService);
        enabled = await config.hasAnyLLMProviderConfigured().catch(() => false);
        if (!enabled) return;
        flow = container.get(AnswerFlowService);
        structured = container.get(StructuredOutputService);
    }, 60_000);

    const scores: Record<string, number[]> = Object.fromEntries(RUBRIC_CRITERIA.map((c) => [c, []]));
    /** Same scores split by fixture group — a mean over everything hides one broken category. */
    const byGroup: Record<string, Record<string, number[]>> = {};

    it.each(fixtures.questions)(
        "$id",
        async (fixture) => {
            if (!enabled) {
                console.warn("No LLM provider configured — skipping eval.");
                return;
            }

            const result = await flow.ask(fixture.question, autoChooser);
            expect(result.answer.length).toBeGreaterThan(0);

            for (const term of fixture.mustMention ?? []) {
                expect(result.answer.toLowerCase()).toContain(term.toLowerCase());
            }

            const context = result.chunks.map((c, i) => `Context ${i + 1}\n${c.content}`).join("\n\n---\n\n");
            const graded = await structured.invoke({
                schema: JudgeSchema,
                name: "grade_answer",
                shapeHint: JUDGE_SHAPE_HINT,
                messages: getJudgeMessages({ question: fixture.question, answer: result.answer, context }),
                options: { temperature: 0 },
            });

            byGroup[fixture.group] ??= Object.fromEntries(RUBRIC_CRITERIA.map((c) => [c, []]));
            for (const criterion of RUBRIC_CRITERIA) {
                scores[criterion].push(graded[criterion]);
                byGroup[fixture.group][criterion].push(graded[criterion]);
            }

            const line = RUBRIC_CRITERIA.map((c) => `${c}=${graded[c]}`).join(" ");
            console.log(`[${fixture.group}/${fixture.id}] ${line} — ${graded.notes}`);
        },
        180_000,
    );

    afterAll(() => {
        if (!enabled || scores.answersQuestion.length === 0) return;

        console.log("\n--- Mean scores (out of 2) ---");
        const failures: string[] = [];
        for (const c of RUBRIC_CRITERIA) {
            const mean = scores[c].reduce((a, b) => a + b, 0) / scores[c].length;
            console.log(`${c.padEnd(18)} ${mean.toFixed(2)}`);
            if (mean < PASS_THRESHOLD) failures.push(`${c} (${mean.toFixed(2)})`);
        }
        if (failures.length > 0) {
            console.warn(`\nBelow the ${PASS_THRESHOLD} threshold: ${failures.join(", ")}`);
        }

        console.log("\n--- Mean scores by group ---");
        for (const [group, groupScores] of Object.entries(byGroup)) {
            const line = RUBRIC_CRITERIA.map((c) => {
                const values = groupScores[c];
                const mean = values.reduce((a, b) => a + b, 0) / values.length;
                return `${c}=${mean.toFixed(2)}`;
            }).join(" ");
            console.log(`${group.padEnd(12)} ${line}`);
        }
    });
});
