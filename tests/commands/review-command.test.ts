import { ReviewCommand } from "../../src/commands/review-command";
import { LLMModel } from "../../src/constants/llm-models";
import { GitService } from "../../src/integrations/github/services/git.service";
import { GitHubDiffService } from "../../src/integrations/github/services/github-diff.service";
import { SCMFactory } from "../../src/integrations/scm/scm-factory.service";
import { SCMService } from "../../src/integrations/scm/scm.model";
import { AIProvider, ConfigService } from "../../src/services/config-service";
import { LlmService } from "../../src/services/llm-service";
import { MultiAgentReviewService } from "../../src/services/review/multi-agent-review.service";
import { TokenUsageTracker } from "../../src/services/token-usage-tracker";

describe("ReviewCommand try/finally token usage reporting", () => {
    let mockGit: jest.Mocked<GitService>;
    let mockDiff: jest.Mocked<GitHubDiffService>;
    let mockScm: jest.Mocked<SCMService>;
    let mockScmFactory: jest.Mocked<SCMFactory>;
    let mockMultiAgent: jest.Mocked<MultiAgentReviewService>;
    let mockConfig: jest.Mocked<ConfigService>;
    let mockLlm: jest.Mocked<LlmService>;
    let command: ReviewCommand;

    beforeEach(() => {
        mockGit = {
            getCurrentBranch: jest.fn().mockResolvedValue("feature-branch"),
            getOwnerAndRepo: jest.fn().mockResolvedValue({ owner: "owner", repo: "repo" }),
        } as unknown as jest.Mocked<GitService>;

        mockDiff = {
            filterDiff: jest.fn().mockReturnValue("diff --git a/file.ts\n+line"),
        } as unknown as jest.Mocked<GitHubDiffService>;

        mockScm = {
            provider: "github",
            getPullRequest: jest.fn().mockResolvedValue({
                title: "Test PR",
                additions: 10,
                deletions: 2,
                changedFiles: 1,
            }),
            getPullRequestDiff: jest.fn().mockResolvedValue("diff content"),
            findPullRequestByBranch: jest.fn().mockResolvedValue(123),
        } as unknown as jest.Mocked<SCMService>;

        mockScmFactory = {
            detect: jest.fn().mockResolvedValue(mockScm),
            get: jest.fn().mockReturnValue(mockScm),
        } as unknown as jest.Mocked<SCMFactory>;

        mockMultiAgent = {
            run: jest.fn(),
            cleanup: jest.fn().mockResolvedValue(undefined),
            findingParser: {
                formatAuditMarkdown: jest.fn().mockReturnValue("audit markdown"),
                formatSummaryTable: jest.fn().mockReturnValue("summary"),
                formatCommentBody: jest.fn().mockReturnValue("comment body"),
            },
        } as unknown as jest.Mocked<MultiAgentReviewService>;

        mockConfig = {
            getSessionConfiguration: jest.fn().mockReturnValue({ debug: false, ci: true, quiet: false }),
        } as unknown as jest.Mocked<ConfigService>;

        mockLlm = {
            resolveModel: jest.fn().mockResolvedValue(LLMModel.BEDROCK_CLAUDE_4_SONNET),
            resolveProvider: jest.fn().mockResolvedValue(AIProvider.BEDROCK),
            resolveSessionInfo: jest.fn().mockResolvedValue({
                provider: AIProvider.BEDROCK,
                model: LLMModel.BEDROCK_CLAUDE_4_SONNET,
            }),
        } as unknown as jest.Mocked<LlmService>;

        command = new ReviewCommand(mockGit, mockDiff, mockScmFactory, mockMultiAgent, mockConfig, mockLlm);
    });

    it("prints token usage summary in finally block even when multiAgent.run rejects after recording usage", async () => {
        const printSummarySpy = jest.spyOn(command as any, "printUsageSummary");

        mockMultiAgent.run.mockImplementation(async (context) => {
            if (context.tracker) {
                context.tracker.record("reviewer:architecture", { inputTokens: 5000, outputTokens: 1000 });
                context.tracker.record("auditor (failed)", { inputTokens: null, outputTokens: null });
            }
            throw new Error("Auditor failed with 429 Rate Limit");
        });

        await expect(command.execute({} as any)).rejects.toThrow("Auditor failed with 429 Rate Limit");

        expect(printSummarySpy).toHaveBeenCalledTimes(1);
        const recordedSummary = printSummarySpy.mock.calls[0][0] as any;
        expect(recordedSummary.calls).toHaveLength(2);
        expect(recordedSummary.calls[0].label).toBe("reviewer:architecture");
        expect(recordedSummary.calls[1].label).toBe("auditor (failed)");
        expect(recordedSummary.totalInput).toBeNull();
        expect(recordedSummary.totalOutput).toBeNull();
    });

    it("cleans up artifacts only on successful completion when keep-artifacts is not set", async () => {
        mockMultiAgent.run.mockResolvedValue({
            audit: { findings: [], verdict: "APPROVED", rawMarkdown: "" },
            artifactsDir: "/path/to/artifacts",
            durationFormatted: "5s",
            durationMs: 5000,
            usage: {
                provider: AIProvider.BEDROCK,
                model: "model",
                calls: [],
                totalInput: 0,
                totalOutput: 0,
                estimatedCost: 0,
            },
        } as any);

        await command.execute({ self: true } as any);

        expect(mockMultiAgent.cleanup).toHaveBeenCalledWith("/path/to/artifacts");
    });

    it("preserves artifacts when execution fails after multiAgent.run returns (e.g. post failure)", async () => {
        mockMultiAgent.run.mockResolvedValue({
            audit: {
                findings: [{ file: "a.ts", line: 1, severity: "major", description: "issue" }],
                verdict: "CHANGES_REQUESTED",
            },
            artifactsDir: "/path/to/artifacts",
            durationFormatted: "5s",
            durationMs: 5000,
            usage: {
                provider: AIProvider.BEDROCK,
                model: "model",
                calls: [],
                totalInput: 0,
                totalOutput: 0,
                estimatedCost: 0,
            },
        } as any);
        mockScm.postInlineReview = jest.fn().mockRejectedValue(new Error("Network 500"));
        mockScm.postReviewComment = jest.fn().mockRejectedValue(new Error("Token 403 Forbidden"));

        await expect(command.execute({ post: true } as any)).rejects.toThrow("Token 403 Forbidden");

        expect(mockMultiAgent.cleanup).not.toHaveBeenCalled();
    });

    it("formats estimatedCost as n/a (self-hosted) when running Ollama / Self-hosted", async () => {
        const printSummarySpy = jest.spyOn(command as any, "printUsageSummary");
        mockLlm.resolveSessionInfo.mockResolvedValue({
            provider: AIProvider.OLLAMA,
            model: "llama3",
        });

        mockMultiAgent.run.mockResolvedValue({
            audit: { findings: [], verdict: "APPROVED", rawMarkdown: "" },
            artifactsDir: "/path/to/artifacts",
            durationFormatted: "5s",
            durationMs: 5000,
            usage: {
                provider: AIProvider.OLLAMA,
                model: "llama3",
                calls: [{ label: "call1", inputTokens: 500, outputTokens: 100 }],
                totalInput: 500,
                totalOutput: 100,
                estimatedCost: null,
            },
        } as any);

        await command.execute({ self: true } as any);

        expect(printSummarySpy).toHaveBeenCalled();
        const recordedSummary = printSummarySpy.mock.calls[printSummarySpy.mock.calls.length - 1][0] as any;
        expect(recordedSummary.provider).toBe(AIProvider.OLLAMA);
        expect(recordedSummary.estimatedCost).toBeNull();
    });
});
