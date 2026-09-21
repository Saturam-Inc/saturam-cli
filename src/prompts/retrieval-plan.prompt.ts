import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

/**
 * Turns a change question into the several searches it actually needs.
 *
 * "What should I change to move the DAG schedule to Friday?" embeds close to documents that
 * *describe* the schedule, and far from the one that says how to change it — so a single search
 * returns a correct-looking set of documents that cannot answer the question. The corpus usually
 * does hold the answer; it is spread across the page that says where the setting lives, the page
 * that says what triggers the job, and the page that says what reads its output.
 *
 * Asking for the sub-questions separately is what reaches those pages. It is also why the fix is
 * retrieval and not more documentation: the pages already exist.
 */
export function getRetrievalPlanMessages(params: {
    question: string;
    projectDisplayName?: string;
    priorSubject?: string;
}): BaseMessage[] {
    const scope = params.projectDisplayName
        ? `The question is about the "${params.projectDisplayName}" project.`
        : `The question is about one of our internal projects.`;

    const continuity = params.priorSubject
        ? `\n\nThe conversation was previously about: ${params.priorSubject}. If the question leans on that, fold the subject into your queries so they stand alone.`
        : "";

    const system = new SystemMessage(
        `You plan the document searches needed to answer a question about changing an internal system. ${scope}

You are not answering anything. You are writing the search queries whose results, together, would let someone answer it.

A change question is answered by several different documents, and searching the user's own wording usually finds none of them. Cover these angles, choosing the ones the question actually needs:

1. **Where it is configured** — the file, setting, table or constant that holds the current value.
2. **How it takes effect** — what triggers, schedules, deploys or restarts the thing, and how a change is picked up.
3. **What depends on it** — what reads the output, what runs after it, what would notice the change.
4. **How to change it** — many teams keep a runbook, a cookbook, a "making changes" or "how to modify" page. Always include one query aimed at that kind of document, phrased the way such a page would be written rather than the way the question was asked.

Rules:
- Write 2 to 4 queries. Fewer is better when the question is narrow.
- Each query must stand alone, with no pronouns and no reference to the other queries.
- Write them as statements of the topic, the way a document's own sentences would read — "how Airflow DAG runs are triggered and scheduled", not "where do I find how to change the DAG schedule?". You are matching against documentation prose, not asking a person.
- Use the system's own vocabulary from the question. Keep names, file paths and identifiers exactly as written.
- Do not invent specifics the question did not contain. If it does not name a file, do not guess a filename.
- Make them genuinely different from each other. Four rewordings of one query retrieve one set of documents and waste three searches.

Also restate, in one sentence, what the user is actually trying to change or find out. That sentence becomes the question the answer is written against, so make it concrete and self-contained.`,
    );

    return [system, new HumanMessage(`Question: ${params.question}${continuity}`)];
}

export const RETRIEVAL_PLAN_SHAPE_HINT = `{
  "intent": string,
  "queries": string[]
}`;
