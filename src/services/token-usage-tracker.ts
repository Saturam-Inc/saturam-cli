import { AIProvider } from "./config-service";

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
}

/**
 * Tracks token usage across multiple LLM calls within a single review session.
 * Safe for concurrent Promise.all usage (Node.js is single-threaded, array push is atomic).
 */
export class TokenUsageTracker {
    private calls: CallUsage[] = [];
    private provider: AIProvider = AIProvider.ANTHROPIC;
    private model: string = "";

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
        let totalInput: number | null = 0;
        let totalOutput: number | null = 0;

        for (const call of this.calls) {
            if (call.inputTokens !== null) {
                totalInput = (totalInput ?? 0) + call.inputTokens;
            } else {
                // If any call is missing input, mark total as partial
                if (totalInput === 0 && this.calls.every((c) => c.inputTokens === null)) {
                    totalInput = null;
                }
            }

            if (call.outputTokens !== null) {
                totalOutput = (totalOutput ?? 0) + call.outputTokens;
            } else {
                if (totalOutput === 0 && this.calls.every((c) => c.outputTokens === null)) {
                    totalOutput = null;
                }
            }
        }

        return {
            provider: this.provider,
            model: this.model,
            calls: [...this.calls],
            totalInput,
            totalOutput,
        };
    }
}
