import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { LLMModel, LLMOptions } from "../../constants/llm-models";
import { LlmService } from "../llm-service";

const logger = getLogger("StructuredOutput");

/**
 * A model exposing LangChain's structured-output binding. Not every member of the ChatModel
 * union has it — SelfHostedChatModel is a bare `invoke`, and some Ollama builds are served by
 * backends without tool-calling support — so it is detected at runtime rather than assumed.
 */
interface StructuredCapableModel {
    withStructuredOutput: (
        schema: unknown,
        options?: { name?: string },
    ) => { invoke(messages: BaseMessage[]): Promise<unknown> };
}

function supportsStructuredOutput(model: unknown): model is StructuredCapableModel {
    return typeof (model as StructuredCapableModel)?.withStructuredOutput === "function";
}

/** Strips ```json fences a model may wrap its JSON in, and trims to the outermost JSON object. */
function extractJsonObject(raw: string): string {
    const withoutFences = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    const start = withoutFences.indexOf("{");
    const end = withoutFences.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return withoutFences.trim();
    return withoutFences.slice(start, end + 1);
}

export interface StructuredRequest<T> {
    /**
     * Zod schema the result must satisfy — also validates the JSON-fallback path. The input type
     * is left open so schemas using `.default()` (where parsed input and output differ) infer T
     * as the parsed output rather than the raw input.
     */
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    /** Name for the tool/function binding, e.g. "classify_intent". */
    name: string;
    /**
     * Plain-text description of the expected JSON shape, used only on the fallback path.
     * Written by hand rather than derived, so it doubles as prompt documentation and avoids
     * adding a JSON-schema generator dependency.
     */
    shapeHint: string;
    messages: BaseMessage[];
    model?: LLMModel;
    options?: LLMOptions;
}

/**
 * Runs a prompt that must return typed data, using native structured output where the provider
 * supports it and falling back to instructed JSON where it does not.
 *
 * The fallback is not a nicety: the CLI supports eight providers, and failing hard on the ones
 * without tool calling would make the whole agent flow unavailable to self-hosted and some
 * Ollama users. One reparse is attempted before giving up, since a malformed first response is
 * usually recoverable by showing the model its own error.
 */
@Service()
export class StructuredOutputService {
    constructor(private readonly llm: LlmService) {}

    public async invoke<T>(request: StructuredRequest<T>): Promise<T> {
        const model = await this.llm.getModel(request.model, request.options);

        if (supportsStructuredOutput(model)) {
            try {
                const bound = model.withStructuredOutput(request.schema, { name: request.name });
                const raw = await bound.invoke(request.messages);
                return request.schema.parse(raw);
            } catch (err) {
                logger.debug(
                    `Native structured output failed for "${request.name}" (${(err as Error).message}) — falling back to instructed JSON.`,
                );
            }
        }

        return this.invokeWithJsonFallback(request);
    }

    private async invokeWithJsonFallback<T>(request: StructuredRequest<T>): Promise<T> {
        const instruction = new HumanMessage(
            `Respond with a single JSON object and nothing else — no prose, no code fences.\n\nExpected shape:\n${request.shapeHint}`,
        );
        const messages = [...request.messages, instruction];

        const first = await this.llm.prompt(messages, request.model, request.options);
        const parsed = this.tryParse(request.schema, first);
        if (parsed.ok) return parsed.value;

        logger.debug(`Instructed-JSON response for "${request.name}" did not validate — retrying once.`);
        const retry = await this.llm.prompt(
            [
                ...messages,
                new HumanMessage(
                    `That response could not be parsed: ${parsed.error}\n\nReturn only the JSON object matching the shape above.`,
                ),
            ],
            request.model,
            request.options,
        );

        const reparsed = this.tryParse(request.schema, retry);
        if (reparsed.ok) return reparsed.value;

        throw new Error(`Model did not return valid JSON for "${request.name}": ${reparsed.error}`);
    }

    private tryParse<T>(
        schema: z.ZodType<T, z.ZodTypeDef, unknown>,
        raw: string,
    ): { ok: true; value: T } | { ok: false; error: string } {
        try {
            return { ok: true, value: schema.parse(JSON.parse(extractJsonObject(raw))) };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    }
}
