import { getFollowUpMessages } from "../../src/prompts/follow-up.prompt";

const chunks = [
    {
        content: "The nightly job runs at 01:30 and writes the daily table.",
        location: "s3://docs/jobs.md",
        metadata: { title: "Jobs", project: "orion" },
    },
];

const systemTextOf = (planGoal?: string) => {
    const [system] = getFollowUpMessages({
        question: "how do I move the nightly job?",
        answer: "1. Edit the schedule. 2. Restart the scheduler.",
        chunks,
        planGoal,
    });
    return String(system.content);
};

describe("follow-up prompt", () => {
    it("offers the learning path after an ordinary answer", () => {
        const text = systemTextOf();
        expect(text).toContain("the natural next step from what was just explained");
        expect(text).not.toContain("The answer is a plan for a change");
    });

    it("offers the steps that carry a plan out after a change plan, not a restatement of it", () => {
        const text = systemTextOf("move the nightly job to 03:00");
        expect(text).toContain("The answer is a plan for a change: move the nightly job to 03:00");
        expect(text).toContain("the tests or checks that cover a step");
        expect(text).toContain("Not a restatement of the plan");
        expect(text).not.toContain("the natural next step from what was just explained");
    });

    it("still requires every entry to cite a listed document in either mode", () => {
        for (const text of [systemTextOf(), systemTextOf("a change")]) {
            expect(text).toContain('cites it as "sourceIndex"');
        }
    });
});
