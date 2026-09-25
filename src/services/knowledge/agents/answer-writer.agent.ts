import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Service } from "typedi";
import { getReviseAnswerMessages } from "../../../prompts/revise-answer.prompt";
import { LlmService } from "../../llm-service";

/** Two sentences of instruction do not need a file of their own. */
const GIST_INSTRUCTION =
    "Summarize an assistant's answer in one sentence, under 25 words. Name the specific subject so a " +
    "later reader can resolve a pronoun against it. No preamble.";

const GIST_TEMPERATURE = 0;
/** A revision changes only what it is told to; any latitude here is a chance to change more. */
const REVISE_TEMPERATURE = 0;

/**
 * The two small jobs that run around an answer rather than producing one.
 *
 * This class used to write the answers too, in three shapes — a description, a change plan and a
 * general-knowledge reply — each with its own prompt and its own temperature, chosen by a branch
 * upstream that guessed which of the three a question wanted before anything was retrieved. The
 * agent writes all three now, as one job, because they were never really three.
 */
@Service()
export class AnswerWriterAgent {
    constructor(private readonly llm: LlmService) {}

    /**
     * Takes back identifiers the sources never mention. The list arrives from a string check, so
     * there is no judgement to make — only names to remove or attribute. See unsupported-identifiers.ts.
     */
    public async revise(params: { question: string; answer: string; unsupported: string[] }): Promise<string> {
        return this.llm.prompt(getReviseAnswerMessages(params), undefined, { temperature: REVISE_TEMPERATURE });
    }

    /**
     * One-line summary stored with the turn. The agent replays gists rather than full answers,
     * which is what keeps a twenty-turn history affordable.
     */
    public async summarize(question: string, answer: string): Promise<string> {
        try {
            const gist = await this.llm.prompt(
                [new SystemMessage(GIST_INSTRUCTION), new HumanMessage(`Question: ${question}\n\nAnswer:\n${answer}`)],
                undefined,
                { temperature: GIST_TEMPERATURE },
            );
            return gist.trim();
        } catch {
            // A failed summary must not lose the turn — fall back to a truncated answer.
            return answer.trim().slice(0, 200);
        }
    }
}
