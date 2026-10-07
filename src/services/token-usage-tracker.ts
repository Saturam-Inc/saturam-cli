import type { AIProvider } from "../constants/ai-provider";
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
    private readonly calls: CallUsage[] = [];

    constructor(
        private readonly provider: AIProvider,
        private readonly model: string,
    ) {}

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
