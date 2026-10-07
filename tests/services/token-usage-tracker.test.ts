import { AIProvider } from "../../src/services/config-service";
import { TokenUsageTracker } from "../../src/services/token-usage-tracker";

describe("TokenUsageTracker", () => {
    let tracker: TokenUsageTracker;

    beforeEach(() => {
        tracker = new TokenUsageTracker(AIProvider.ANTHROPIC, "claude-3-5-sonnet-20241022");
    });

    it("should initialize with constructor values and empty calls", () => {
        const summary = tracker.getSummary();
        expect(summary.provider).toBe(AIProvider.ANTHROPIC);
        expect(summary.model).toBe("claude-3-5-sonnet-20241022");
        expect(summary.calls).toEqual([]);
        expect(summary.totalInput).toBe(0);
        expect(summary.totalOutput).toBe(0);
    });

    it("should record individual calls and aggregate totals accurately", () => {
        tracker.record("reviewer:architecture", { inputTokens: 12430, outputTokens: 2180 });
        tracker.record("reviewer:data-flow", { inputTokens: 12430, outputTokens: 1940 });
        tracker.record("auditor", { inputTokens: 18900, outputTokens: 3050 });
        tracker.record("extract-findings", { inputTokens: 4120, outputTokens: 890 });

        const summary = tracker.getSummary();

        expect(summary.calls).toHaveLength(4);
        expect(summary.calls[0]).toEqual({
            label: "reviewer:architecture",
            inputTokens: 12430,
            outputTokens: 2180,
        });
        expect(summary.totalInput).toBe(12430 + 12430 + 18900 + 4120); // 47,880
        expect(summary.totalOutput).toBe(2180 + 1940 + 3050 + 890); // 8,060
    });

    it("should return null totals when all calls have null token counts", () => {
        const ollamaTracker = new TokenUsageTracker(AIProvider.OLLAMA, "llama3");

        ollamaTracker.record("reviewer:architecture", { inputTokens: null, outputTokens: null });
        ollamaTracker.record("reviewer:data-flow", { inputTokens: null, outputTokens: null });

        const summary = ollamaTracker.getSummary();
        expect(summary.calls).toHaveLength(2);
        expect(summary.totalInput).toBeNull();
        expect(summary.totalOutput).toBeNull();
    });

    it("should return null for total when any individual call has null tokens (partial failure)", () => {
        const ollamaTracker = new TokenUsageTracker(AIProvider.OLLAMA, "llama3");

        ollamaTracker.record("reviewer:architecture", { inputTokens: 1000, outputTokens: 200 });
        ollamaTracker.record("reviewer:data-flow", { inputTokens: null, outputTokens: null });

        const summary = ollamaTracker.getSummary();
        expect(summary.calls).toHaveLength(2);
        expect(summary.totalInput).toBeNull();
        expect(summary.totalOutput).toBeNull();
    });

    it("should return a defensive copy of calls array to prevent mutation", () => {
        tracker.record("reviewer:architecture", { inputTokens: 100, outputTokens: 50 });
        const summary1 = tracker.getSummary();
        summary1.calls[0].inputTokens = 9999;

        const summary2 = tracker.getSummary();
        expect(summary2.calls[0].inputTokens).toBe(100);
    });

    it("should safely handle concurrent recordings via Promise.all", async () => {
        await Promise.all([
            Promise.resolve().then(() =>
                tracker.record("reviewer:architecture", { inputTokens: 500, outputTokens: 100 }),
            ),
            Promise.resolve().then(() => tracker.record("reviewer:data-flow", { inputTokens: 600, outputTokens: 150 })),
        ]);

        const summary = tracker.getSummary();
        expect(summary.calls).toHaveLength(2);
        expect(summary.totalInput).toBe(1100);
        expect(summary.totalOutput).toBe(250);
    });

    it("should calculate estimatedCost correctly for paid models", () => {
        const paidTracker = new TokenUsageTracker(AIProvider.ANTHROPIC, "claude-sonnet-4-5-20250929");
        // Rate: $3.00/1M input, $15.00/1M output
        // 100,000 in = $0.30, 20,000 out = $0.30 -> total $0.60
        paidTracker.record("call1", { inputTokens: 100_000, outputTokens: 20_000 });

        const summary = paidTracker.getSummary();
        expect(summary.estimatedCost).toBeCloseTo(0.6, 4);
    });

    it("should return null estimatedCost for local / self-hosted models", () => {
        const localTracker = new TokenUsageTracker(AIProvider.OLLAMA, "llama3");
        localTracker.record("call1", { inputTokens: 50_000, outputTokens: 10_000 });

        const summary = localTracker.getSummary();
        expect(summary.estimatedCost).toBeNull();
    });

    it("should return null estimatedCost if any token counts are missing", () => {
        const openAiTracker = new TokenUsageTracker(AIProvider.OPENAI, "gpt-4o");
        openAiTracker.record("call1", { inputTokens: null, outputTokens: 500 });

        const summary = openAiTracker.getSummary();
        expect(summary.estimatedCost).toBeNull();
    });

    it("should handle failed call recording with null tokens and label", () => {
        const bedrockTracker = new TokenUsageTracker(AIProvider.BEDROCK, "anthropic.claude-3-5-sonnet-20241022-v2:0");
        bedrockTracker.record("reviewer:architecture", { inputTokens: 5000, outputTokens: 1200 });
        bedrockTracker.record("auditor (failed)", { inputTokens: null, outputTokens: null });

        const summary = bedrockTracker.getSummary();
        expect(summary.calls).toHaveLength(2);
        expect(summary.calls[1].label).toBe("auditor (failed)");
        expect(summary.calls[1].inputTokens).toBeNull();
        expect(summary.calls[1].outputTokens).toBeNull();
        expect(summary.totalInput).toBeNull();
        expect(summary.totalOutput).toBeNull();
        expect(summary.estimatedCost).toBeNull();
    });
});
