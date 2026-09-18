import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { RetrievedChunk } from "../integrations/aws/services/bedrock-knowledge-base.service";

/**
 * Decides whether retrieved context actually answers the question, before any answer is written.
 *
 * Vector retrieval always returns its closest matches, however far off they are — a question about
 * AWS Lambda pulls back documents about the Llama API because the words look alike. Without this
 * gate the answering model treats whatever came back as the answer and writes a confident,
 * plausible, wrong reply. The cost of one extra structured call is worth not doing that.
 */
export function getGroundingCheckMessages(params: { question: string; chunks: RetrievedChunk[] }): BaseMessage[] {
    const system = new SystemMessage(
        `You judge whether retrieved documents are about the right subject, before an answer is written.

**Your default verdict is "sufficient".** You are a narrow safety check for one specific failure: retrieval returning documents about a different thing that merely resembles the question's subject. You are NOT a quality bar, and you are NOT asking whether the documentation is complete. Almost nothing is documented comprehensively, and partial coverage is normal and fine — the answering step is already required to answer what it can and name what is missing.

Verdicts:
- "sufficient" — the documents are about the right subject. Use this whenever the subject appears at all, even if the coverage is thin, scattered, partial, or only answers part of the question. This is the common case by a wide margin.
- "wrong_subject" — the documents are about something genuinely different that merely looks similar. Watch for near-identical names: "Lambda" (AWS compute) is not "Llama" (a language model); "Airflow" is not "Azure". Use this ONLY when the question's actual subject is absent and something else has been matched in its place.
- "ambiguous" — the question has two or more clearly different readings and the documents cover more than one, so answering would mean picking one at random.

Do not use "wrong_subject" because the documents are shallow, or because you would have liked more detail, or because no single document gives a full overview. Scattered mentions across several documents are sufficient.

Then:
- missing: one sentence naming what is absent. Empty when the verdict is "sufficient".
- alternativeQuestions: 2 to 4 entries, ONLY when the verdict is not "sufficient". These are **rephrased questions the user might have meant**, ready to be searched — not questions directed back at the user. Write each as a complete question about a subject the documents genuinely do cover, or a sharper version of the original. Good: "Which AWS services does the DE Framework integrate with?". Bad: "Are you looking for technical details or an overview?" — that asks the user to do the work and cannot be searched.`,
    );

    const documents = params.chunks.length
        ? params.chunks
              .map((chunk, index) => {
                  const title =
                      typeof chunk.metadata?.title === "string" ? chunk.metadata.title : `Document ${index + 1}`;
                  const project = typeof chunk.metadata?.project === "string" ? ` · ${chunk.metadata.project}` : "";
                  return `Document ${index + 1}: ${title}${project}\n${chunk.content.trim().slice(0, 700)}`;
              })
              .join("\n\n---\n\n")
        : "(nothing was retrieved)";

    return [system, new HumanMessage(`Question: ${params.question}\n\nRetrieved documents:\n${documents}`)];
}

export const GROUNDING_CHECK_SHAPE_HINT = `{
  "verdict": "sufficient" | "wrong_subject" | "ambiguous",
  "missing": string,
  "alternativeQuestions": string[]
}`;
