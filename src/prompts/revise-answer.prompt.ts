import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

/**
 * Asks the writer to take back identifiers it named that the sources never mention.
 *
 * This replaces a model-judged audit that could not tell invention from correct recall on the
 * models the CLI supports. The check that triggers this is string-based — a path, file name,
 * table or script the answer used that appears nowhere in the retrieved text — so the request
 * arrives with a short, exact list and no judgement call. The writer is told to change nothing
 * else: a revision that rewrites the whole answer would trade one risk for another.
 */
export function getReviseAnswerMessages(params: {
    question: string;
    answer: string;
    unsupported: string[];
}): BaseMessage[] {
    const list = params.unsupported.map((identifier) => `- \`${identifier}\``).join("\n");

    const system = new SystemMessage(
        `You wrote the answer below from a set of source documents. A literal search of those documents finds no trace of these identifiers you used:

${list}

Revise the answer so it no longer asserts them. For each one, either:
- use the name the sources actually give, if the same thing is named differently there, or
- remove it, or
- keep the point but say plainly that the sources do not name it — "the documentation does not name the script that does this".

Change nothing else. Keep the tone, the structure, every other detail and the length as they are. Do not add caveats about anything not on the list. Return only the revised answer.`,
    );

    return [system, new HumanMessage(`Question: ${params.question}\n\nAnswer to revise:\n${params.answer}`)];
}
