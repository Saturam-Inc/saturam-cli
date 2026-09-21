import { Service } from "typedi";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { getChangeAdvisorMessages } from "../../../prompts/change-advisor.prompt";
import { getGeneralTechnicalMessages } from "../../../prompts/general-technical.prompt";
import { getAnswerGistMessages, getMentorAnswerMessages } from "../../../prompts/mentor-answer.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, SessionDigest } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";

/**
 * Per-mode temperatures. A description is a piece of writing and reads better with some give; a
 * change plan is closer to a procedure, where a reworded step is a risk rather than a flourish.
 */
const DESCRIBE_TEMPERATURE = 0.4;
const GENERAL_TEMPERATURE = 0.3;
const ADVISE_TEMPERATURE = 0.2;
const GIST_TEMPERATURE = 0;

interface AnswerRequest {
    question: string;
    chunks: RetrievedChunk[];
    projectDisplayName?: string;
    recentTurns: ChatTurn[];
    digest?: SessionDigest;
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

    /** The mentoring explanation: what it is, why it exists, how it works, where to look. */
    public async describe(params: AnswerRequest): Promise<string> {
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
