import { getChangeAdvisorMessages } from "../../src/prompts/change-advisor.prompt";
import { getFollowUpMessages } from "../../src/prompts/follow-up.prompt";
import { getGeneralTechnicalMessages } from "../../src/prompts/general-technical.prompt";
import { getGroundingCheckMessages } from "../../src/prompts/grounding-check.prompt";
import { getIntentClassifierMessages } from "../../src/prompts/intent-classifier.prompt";
import { getKnowledgeBaseChatMessages } from "../../src/prompts/knowledge-base-chat.prompt";
import { getMentorAnswerMessages } from "../../src/prompts/mentor-answer.prompt";
import { getProjectRouterMessages } from "../../src/prompts/project-router.prompt";
import { getQuizAssessMessages, getQuizPoseMessages } from "../../src/prompts/quiz.prompt";
import { getRetrievalPlanMessages } from "../../src/prompts/retrieval-plan.prompt";
import { getReviseAnswerMessages } from "../../src/prompts/revise-answer.prompt";
import { getSessionDigestMessages } from "../../src/prompts/session-digest.prompt";
import { LearnerStage, QuestionIntent } from "../../src/services/knowledge/chat-session.model";

/**
 * Guards the rule that prompts carry no client's vocabulary.
 *
 * Every project name a prompt uses must come in through its parameters — from the registry, or
 * from the retrieved documents' metadata — never from the prompt text itself. The CLI is one
 * binary serving every client's deployment, so a name baked in here ships to all of them: the
 * classifier learns one client's phrasing, and anyone reading the prompt concludes the tool was
 * built for that client alone.
 *
 * The prompts are rendered here with deliberately neutral inputs, so anything on the list below
 * that still appears can only have come from the prompt source. Extend the list whenever a new
 * client's terms are noticed in a prompt; the test is the reason they will not be there for long.
 */
const CLIENT_TERMS = [
    /\bMRF\b/,
    /\bSMILE\b/,
    /\bARAP\b/,
    /\bADF\b/,
    /\bAirflow\b/,
    /\bQualdo\b/,
    /DE Framework/,
    /\bpkl\b/,
    /spend domain/i,
    /Azure Data Factory/,
    /cons\.sh/,
];

const NEUTRAL = {
    question: "how does the scheduler decide what to run?",
    answer: "It reads a table of jobs and runs whichever are due.",
    catalogue: "(no projects are indexed yet)",
    exampleProject: "the project",
};

/** Every prompt the chat flow can send, rendered with inputs that name no project. */
function renderAll(): Array<{ name: string; text: string }> {
    const flat = (name: string, messages: Array<{ content: unknown }>) => ({
        name,
        text: messages.map((m) => String(m.content)).join("\n"),
    });
    const kb = getKnowledgeBaseChatMessages({ question: NEUTRAL.question, chunks: [] });

    return [
        flat(
            "intent-classifier",
            getIntentClassifierMessages({
                question: NEUTRAL.question,
                recentTurns: [],
                projectCatalogue: NEUTRAL.catalogue,
                exampleProject: NEUTRAL.exampleProject,
            }),
        ),
        flat("grounding-check", getGroundingCheckMessages({ question: NEUTRAL.question, chunks: [] })),
        flat(
            "mentor-answer",
            getMentorAnswerMessages({
                question: NEUTRAL.question,
                chunks: [],
                recentTurns: [],
                stage: LearnerStage.ORIENTING,
            }),
        ),
        flat(
            "mentor-answer (deepening, with goal)",
            getMentorAnswerMessages({
                question: NEUTRAL.question,
                chunks: [],
                recentTurns: [],
                stage: LearnerStage.DEEPENING,
                learnerGoal: "get it running locally",
            }),
        ),
        flat("change-advisor", getChangeAdvisorMessages({ question: NEUTRAL.question, chunks: [], recentTurns: [] })),
        flat(
            "general-technical (nothing indexed)",
            getGeneralTechnicalMessages({
                question: NEUTRAL.question,
                recentTurns: [],
                hasIndexedProjects: false,
                chunks: [],
            }),
        ),
        flat(
            "general-technical (indexed, nothing found)",
            getGeneralTechnicalMessages({
                question: NEUTRAL.question,
                recentTurns: [],
                hasIndexedProjects: true,
                chunks: [],
            }),
        ),
        flat("retrieval-plan", getRetrievalPlanMessages({ question: NEUTRAL.question })),
        flat(
            "follow-up",
            getFollowUpMessages({
                question: NEUTRAL.question,
                answer: NEUTRAL.answer,
                chunks: [],
                stage: LearnerStage.ORIENTING,
            }),
        ),
        flat(
            "revise-answer",
            getReviseAnswerMessages({
                question: NEUTRAL.question,
                answer: NEUTRAL.answer,
                unsupported: ["jobs/run.sh"],
            }),
        ),
        flat(
            "quiz-pose",
            getQuizPoseMessages({
                recentTurns: [
                    {
                        index: 0,
                        question: NEUTRAL.question,
                        answer: NEUTRAL.answer,
                        answerGist: "the scheduler reads a table",
                        intent: QuestionIntent.PROJECT_KNOWLEDGE,
                        retrievedChunkIds: [],
                        createdAt: "2026-01-01T00:00:00Z",
                    },
                ],
            }),
        ),
        flat(
            "quiz-assess",
            getQuizAssessMessages({
                question: "Quick check — what decides when a job runs?",
                modelAnswer: "A table of jobs with due times.",
                keyPoints: ["the table", "due times"],
                learnerAnswer: "the table",
            }),
        ),
        flat(
            "project-router",
            getProjectRouterMessages({
                question: NEUTRAL.question,
                projectCatalogue: NEUTRAL.catalogue,
                candidateEvidence: "",
            }),
        ),
        flat("session-digest", getSessionDigestMessages({ turns: [] })),
        flat("knowledge-base-chat", [kb.system, kb.user]),
    ];
}

describe("prompts carry no client vocabulary", () => {
    it.each(renderAll())("$name", ({ text }) => {
        const found = CLIENT_TERMS.filter((term) => term.test(text)).map(String);
        expect(found).toEqual([]);
    });

    it("takes the classifier's example project from the registry, not the prompt", () => {
        const [system] = getIntentClassifierMessages({
            question: NEUTRAL.question,
            recentTurns: [],
            projectCatalogue: "- Orion [slug: orion]",
            exampleProject: "Orion",
        });

        const text = String(system.content);
        expect(text).toContain("How does Orion handle refunds?");
        expect(text).toContain("what tech stacks are used in Orion");
    });

    it("takes the grounding check's example project from the documents it is judging", () => {
        const [system] = getGroundingCheckMessages({
            question: NEUTRAL.question,
            chunks: [
                { content: "a", metadata: { project: "orion" } },
                { content: "b", metadata: { project: "orion" } },
                { content: "c", metadata: { project: "vega" } },
            ],
        });

        const text = String(system.content);
        expect(text).toContain("asks about orion and the documents are about orion");
        expect(text).not.toContain("vega and the documents");
    });

    it("reads naturally when nothing is indexed and there is no project to name", () => {
        const [system] = getIntentClassifierMessages({
            question: NEUTRAL.question,
            recentTurns: [],
            projectCatalogue: NEUTRAL.catalogue,
            exampleProject: NEUTRAL.exampleProject,
        });

        expect(String(system.content)).toContain("what tech stacks are used in the project");
        expect(String(system.content)).not.toContain("the project project");
    });
});
