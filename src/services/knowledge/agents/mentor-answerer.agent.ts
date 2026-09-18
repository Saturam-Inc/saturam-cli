import { Service } from "typedi";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { getAnswerGistMessages, getMentorAnswerMessages } from "../../../prompts/mentor-answer.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, SessionDigest } from "../chat-session.model";

const TEMPERATURE = 0.4;
const GIST_TEMPERATURE = 0;

/**
 * Produces the mentoring answer: a synthesized explanation following the answer contract, rather
 * than a walk through retrieved excerpts.
 */
@Service()
export class MentorAnswererAgent {
    constructor(private readonly llm: LlmService) {}

    public async answer(params: {
        question: string;
        chunks: RetrievedChunk[];
        projectDisplayName?: string;
        recentTurns: ChatTurn[];
        digest?: SessionDigest;
    }): Promise<string> {
        return this.llm.prompt(getMentorAnswerMessages(params), undefined, { temperature: TEMPERATURE });
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
