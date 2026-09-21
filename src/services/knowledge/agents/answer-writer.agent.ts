import { Service } from "typedi";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { getChangeAdvisorMessages } from "../../../prompts/change-advisor.prompt";
import { getGeneralTechnicalMessages } from "../../../prompts/general-technical.prompt";
import { getAnswerGistMessages, getMentorAnswerMessages } from "../../../prompts/mentor-answer.prompt";
import { getReviseAnswerMessages } from "../../../prompts/revise-answer.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, LearnerStage, SessionDigest } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";

/**
 * Per-mode temperatures. A description is a piece of writing and reads better with some give; a
 * change plan is closer to a procedure, where a reworded step is a risk rather than a flourish.
 */
const DESCRIBE_TEMPERATURE = 0.4;
const GENERAL_TEMPERATURE = 0.3;
const ADVISE_TEMPERATURE = 0.2;
const GIST_TEMPERATURE = 0;
/** A revision changes only what it is told to; any latitude here is a chance to change more. */
const REVISE_TEMPERATURE = 0;

interface AnswerRequest {
    question: string;
    chunks: RetrievedChunk[];
    projectDisplayName?: string;
    recentTurns: ChatTurn[];
    digest?: SessionDigest;
    /** What the learner said they are here to do, if they said. */
    learnerGoal?: string;
}

/**
 * Writes the answer, in whichever of three shapes the question calls for.
 *
 * These were three separate agents. They are one now because none of them decides anything — the
 * flow has already chosen the shape by the time it gets here, and all three take the same inputs,
 * hold the same single dependency, and fail the same way. Three classes differing only in which
 * prompt they pass through was decomposition without a decision to decompose.
 *
 * The prompts themselves stay in their own files and are untouched by the merge. What changes is
 * the number of collaborators the flow has to hold, not a word of what any model is asked.
 */
@Service()
export class AnswerWriterAgent {
    constructor(
        private readonly llm: LlmService,
        private readonly registry: ProjectRegistryService,
    ) {}

    /** The mentoring explanation, pitched to where the learner is in the conversation. */
    public async describe(params: AnswerRequest & { stage: LearnerStage }): Promise<string> {
        return this.llm.prompt(getMentorAnswerMessages(params), undefined, { temperature: DESCRIBE_TEMPERATURE });
    }

    /** The change plan: what to edit, how it takes effect, what it affects, how to verify. */
    public async advise(params: AnswerRequest): Promise<string> {
        return this.llm.prompt(getChangeAdvisorMessages(params), undefined, { temperature: ADVISE_TEMPERATURE });
    }

    /**
     * A general engineering answer, with whatever our own documentation had to say folded in.
     * `chunks` may be empty — that is a meaningful state, not a missing argument, and the prompt
     * says so explicitly rather than staying silent about a corpus it did search.
     */
    public async general(params: {
        question: string;
        recentTurns: ChatTurn[];
        digest?: SessionDigest;
        chunks?: RetrievedChunk[];
        learnerGoal?: string;
    }): Promise<string> {
        const { projects } = await this.registry.load();
        const messages = getGeneralTechnicalMessages({
            ...params,
            chunks: params.chunks ?? [],
            hasIndexedProjects: projects.length > 0,
        });
        return this.llm.prompt(messages, undefined, { temperature: GENERAL_TEMPERATURE });
    }

    /**
     * Takes back identifiers the sources never mention. The list arrives from a string check, so
     * there is no judgement to make — only names to remove or attribute. See unsupported-identifiers.ts.
     */
    public async revise(params: { question: string; answer: string; unsupported: string[] }): Promise<string> {
        return this.llm.prompt(getReviseAnswerMessages(params), undefined, { temperature: REVISE_TEMPERATURE });
    }

    /**
     * One-line summary stored with the turn. Agents replay gists rather than full answers, which
     * is what keeps a twenty-turn history affordable.
     */
    public async summarize(question: string, answer: string): Promise<string> {
        try {
            const gist = await this.llm.prompt(getAnswerGistMessages({ question, answer }), undefined, {
                temperature: GIST_TEMPERATURE,
            });
            return gist.trim();
        } catch {
            // A failed summary must not lose the turn — fall back to a truncated answer.
            return answer.trim().slice(0, 200);
        }
    }
}
