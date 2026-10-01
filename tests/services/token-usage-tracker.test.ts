import { AIProvider } from "../../src/services/config-service";
import { TokenUsageTracker } from "../../src/services/token-usage-tracker";

describe("TokenUsageTracker", () => {
    let tracker: TokenUsageTracker;

    beforeEach(() => {
        tracker = new TokenUsageTracker();
    });

    it("should initialize with default values and empty calls", () => {
        const summary = tracker.getSummary();
        expect(summary.calls).toEqual([]);
        expect(summary.totalInput).toBe(0);
        expect(summary.totalOutput).toBe(0);
    });

    it("should update provider and model via setProviderInfo", () => {
        tracker.setProviderInfo(AIProvider.OPENAI, "gpt-4o");
        const summary = tracker.getSummary();
        expect(summary.provider).toBe(AIProvider.OPENAI);
        expect(summary.model).toBe("gpt-4o");
    });

    it("should record individual calls and aggregate totals accurately", () => {
        tracker.setProviderInfo(AIProvider.ANTHROPIC, "claude-3-5-sonnet-20241022");

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
        tracker.setProviderInfo(AIProvider.OLLAMA, "llama3");

        tracker.record("reviewer:architecture", { inputTokens: null, outputTokens: null });
        tracker.record("reviewer:data-flow", { inputTokens: null, outputTokens: null });

        const summary = tracker.getSummary();
        expect(summary.calls).toHaveLength(2);
        expect(summary.totalInput).toBeNull();
        expect(summary.totalOutput).toBeNull();
    });

    it("should return null for total when any individual call has null tokens (partial failure)", () => {
        tracker.setProviderInfo(AIProvider.OLLAMA, "llama3");

        tracker.record("reviewer:architecture", { inputTokens: 1000, outputTokens: 200 });
        tracker.record("reviewer:data-flow", { inputTokens: null, outputTokens: null });

        const summary = tracker.getSummary();
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
        tracker.setProviderInfo(AIProvider.ANTHROPIC, "claude-3-5-sonnet-20241022");

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
        tracker.setProviderInfo(AIProvider.ANTHROPIC, "claude-sonnet-4-5-20250929");
        // Rate: $3.00/1M input, $15.00/1M output
        // 100,000 in = $0.30, 20,000 out = $0.30 -> total $0.60
        tracker.record("call1", { inputTokens: 100_000, outputTokens: 20_000 });

        const summary = tracker.getSummary();
        expect(summary.estimatedCost).toBeCloseTo(0.6, 4);
    });

    it("should return $0 estimatedCost for local / self-hosted models", () => {
        tracker.setProviderInfo(AIProvider.OLLAMA, "llama3");
        tracker.record("call1", { inputTokens: 50_000, outputTokens: 10_000 });

        const summary = tracker.getSummary();
        expect(summary.estimatedCost).toBe(0);
    });

    it("should return null estimatedCost if any token counts are missing", () => {
        tracker.setProviderInfo(AIProvider.OPENAI, "gpt-4o");
        tracker.record("call1", { inputTokens: null, outputTokens: 500 });

        const summary = tracker.getSummary();
        expect(summary.estimatedCost).toBeNull();
    });
});
