import { AIProvider } from "./config-service";
import { calculateCost } from "../constants/model-pricing";

export interface CallUsage {
    label: string;
    inputTokens: number | null;
    outputTokens: number | null;
}

export interface UsageSummary {
    provider: AIProvider;
    model: string;
    calls: CallUsage[];
    totalInput: number | null;
    totalOutput: number | null;
    estimatedCost: number | null;
}

/**
 * Tracks token usage across multiple LLM calls within a single review session.
 * Safe for concurrent Promise.all usage (Node.js is single-threaded, array push is atomic).
 */
export class TokenUsageTracker {
    private calls: CallUsage[] = [];
    private provider: AIProvider;
    private model: string;

    constructor(provider: AIProvider = AIProvider.ANTHROPIC, model: string = "") {
        this.provider = provider;
        this.model = model;
    }

    public setProviderInfo(provider: AIProvider, model: string): void {
        this.provider = provider;
        this.model = model;
    }

    public record(label: string, usage: { inputTokens: number | null; outputTokens: number | null }): void {
        this.calls.push({
            label,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
        });
    }

    public getSummary(): UsageSummary {
        let totalInput = 0;
        let anyInputMissing = false;
        let totalOutput = 0;
        let anyOutputMissing = false;

        for (const call of this.calls) {
            if (call.inputTokens === null) {
                anyInputMissing = true;
            } else {
                totalInput += call.inputTokens;
            }

            if (call.outputTokens === null) {
                anyOutputMissing = true;
            } else {
                totalOutput += call.outputTokens;
            }
        }

        const totalIn = anyInputMissing ? null : totalInput;
        const totalOut = anyOutputMissing ? null : totalOutput;
        const estimatedCost = calculateCost(this.model, totalIn, totalOut, this.provider);

        return {
            provider: this.provider,
            model: this.model,
            calls: this.calls.map((call) => ({ ...call })),
            totalInput: totalIn,
            totalOutput: totalOut,
            estimatedCost,
        };
    }
}
