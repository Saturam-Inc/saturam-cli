import { input, select } from "@inquirer/prompts";
import { OnboardCommand } from "../../src/commands/onboard-command";
import { ConfigService } from "../../src/services/config-service";
import { KnowledgeBaseChatService } from "../../src/services/knowledge/knowledge-base-chat.service";
import { AnswerFlowService } from "../../src/services/knowledge/answer-flow.service";

jest.mock("@inquirer/prompts", () => ({
    input: jest.fn(),
    select: jest.fn(),
}));

describe("OnboardCommand Mode Routing", () => {
    let command: OnboardCommand;
    let mockConfigService: jest.Mocked<ConfigService>;
    let mockChatService: jest.Mocked<KnowledgeBaseChatService>;
    let mockAnswerFlow: jest.Mocked<AnswerFlowService>;
    let originalStdinIsTTY: boolean | undefined;

    beforeAll(() => {
        originalStdinIsTTY = process.stdin.isTTY;
        // The REPL modes (--knowledge-base/--chat) refuse to prompt on a non-TTY stdin (real
        // pipes/redirects can't be typed into) — force it on so mocked `input()` drives the loop
        // the way an interactive terminal would.
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    });

    afterAll(() => {
        Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockConfigService = {
            hasAnyLLMProviderConfigured: jest.fn().mockResolvedValue(true),
        } as any;

        mockAnswerFlow = {
            startNewSession: jest.fn(),
            ask: jest.fn().mockResolvedValue({
                answer: "an answer",
                chunks: [],
                followUps: [],
            }),
        } as any;

        mockChatService = {
            search: jest.fn().mockResolvedValue([]),
            ask: jest.fn().mockResolvedValue({ answer: "Here is the answer.", chunks: [] }),
        } as any;

        command = new OnboardCommand(mockConfigService, mockChatService, mockAnswerFlow);
    });

    describe("--knowledge-base interactive search", () => {
        const kbInputs = { "knowledge-base": true } as const;

        it("exits immediately without prompting when stdin is not a TTY", async () => {
            Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
            try {
                await command.execute(kbInputs);
            } finally {
                Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
            }

            expect(input).not.toHaveBeenCalled();
            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("enters the search loop", async () => {
            (input as jest.Mock).mockResolvedValueOnce("");

            await command.execute(kbInputs);

            expect(input).toHaveBeenCalledTimes(1);
            expect(input).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: "Ask Saturam-CLI :",
                    theme: { prefix: { idle: "🤖", done: "🤖" } },
                }),
            );
        });

        it("exits immediately on blank input", async () => {
            (input as jest.Mock).mockResolvedValueOnce("   ");

            await command.execute(kbInputs);

            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("exits on 'exit' or 'quit' (case-insensitive)", async () => {
            (input as jest.Mock).mockResolvedValueOnce("EXIT");

            await command.execute(kbInputs);

            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("treats Ctrl+C as a normal exit", async () => {
            const exitError = new Error("User force closed the prompt");
            exitError.name = "ExitPromptError";
            (input as jest.Mock).mockRejectedValueOnce(exitError);

            await expect(command.execute(kbInputs)).resolves.toBeUndefined();

            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("retrieves results for each question until exit", async () => {
            (input as jest.Mock)
                .mockResolvedValueOnce("what is the auth flow?")
                .mockResolvedValueOnce("what is onboarding?")
                .mockResolvedValueOnce("");
            (mockChatService.search as jest.Mock)
                .mockResolvedValueOnce([{ content: "chunk one", score: 0.9, location: "s3://bucket/key.md" }])
                .mockResolvedValueOnce([]);

            await command.execute(kbInputs);

            expect(mockChatService.search).toHaveBeenCalledTimes(2);
            expect(mockChatService.search).toHaveBeenNthCalledWith(1, "what is the auth flow?", {
                project: undefined,
            });
            expect(mockChatService.search).toHaveBeenNthCalledWith(2, "what is onboarding?", { project: undefined });
        });

        it("passes --project through to retrieval as a slug", async () => {
            (input as jest.Mock).mockResolvedValueOnce("what is the auth flow?").mockResolvedValueOnce("");

            await command.execute({ ...kbInputs, project: "Saturam Core" });

            expect(mockChatService.search).toHaveBeenCalledWith("what is the auth flow?", {
                project: "saturam-core",
            });
        });

        it("logs an error and keeps looping when retrieve throws", async () => {
            (input as jest.Mock).mockResolvedValueOnce("bad query").mockResolvedValueOnce("");
            (mockChatService.search as jest.Mock).mockRejectedValueOnce(new Error("KB not configured"));

            await expect(command.execute(kbInputs)).resolves.toBeUndefined();

            expect(input).toHaveBeenCalledTimes(2);
        });
    });

    describe("--chat RAG search", () => {
        const chatInputs = { chat: true } as const;

        it("shows a setup suggestion and skips everything else when no LLM provider is configured", async () => {
            (mockConfigService.hasAnyLLMProviderConfigured as jest.Mock).mockResolvedValue(false);

            await command.execute(chatInputs);

            expect(input).not.toHaveBeenCalled();
            expect(mockAnswerFlow.ask).not.toHaveBeenCalled();
        });

        it("routes the question through the answering flow and prints the answer", async () => {
            const stdoutIsTTY = process.stdout.isTTY;
            Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
            (input as jest.Mock).mockResolvedValueOnce("what is the auth flow?").mockResolvedValueOnce("");
            (mockAnswerFlow.ask as jest.Mock).mockResolvedValueOnce({
                answer: "The auth flow uses OAuth2. [1]",
                chunks: [
                    { content: "auth uses OAuth2", score: 0.95, location: "s3://bucket/auth.md" },
                    { content: "more auth context", score: 0.92, location: "s3://bucket/auth.md" },
                ],
                followUps: [],
            });

            try {
                await command.execute(chatInputs);
            } finally {
                Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });
            }

            expect(mockAnswerFlow.ask).toHaveBeenCalledWith("what is the auth flow?");
            expect((command as any).renderAnswer("The auth flow uses OAuth2. [1]")).toBe("The auth flow uses OAuth2.");
        });

        it("ignores --project, since the flow determines the project per question", async () => {
            (input as jest.Mock).mockResolvedValueOnce("give me the overview").mockResolvedValueOnce("");

            await command.execute({ ...chatInputs, project: "Saturam Core" });

            // The question reaches the flow unscoped: routing is automatic, and a stale manual
            // filter silently returning nothing is the failure mode the redesign removes.
            expect(mockAnswerFlow.ask).toHaveBeenCalledWith("give me the overview");
        });

        it("starts a fresh conversation when --new-session is passed", async () => {
            (input as jest.Mock).mockResolvedValueOnce("");

            await command.execute({ ...chatInputs, "new-session": true });

            expect(mockAnswerFlow.startNewSession).toHaveBeenCalled();
        });

        it("offers the generated follow-ups and asks the selected one next", async () => {
            (input as jest.Mock).mockResolvedValueOnce("what is onboarding?").mockResolvedValueOnce("");
            (mockAnswerFlow.ask as jest.Mock)
                .mockResolvedValueOnce({
                    answer: "Onboarding syncs documents.",
                    chunks: [],
                    followUps: [{ question: "How does the sync handle failures?", rationale: "" }],
                })
                .mockResolvedValueOnce({
                    answer: "It retries with backoff.",
                    chunks: [],
                    followUps: [],
                });
            (select as jest.Mock).mockResolvedValueOnce("How does the sync handle failures?");

            await command.execute(chatInputs);

            expect(mockAnswerFlow.ask).toHaveBeenNthCalledWith(2, "How does the sync handle failures?");
        });

        it("shows a terminal loading spinner while waiting for the chat answer", async () => {
            const originalIsTTY = process.stderr.isTTY;
            const writeSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
            Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

            try {
                (input as jest.Mock).mockResolvedValueOnce("what is onboarding?").mockResolvedValueOnce("");

                let resolveAnswer!: (result: Record<string, unknown>) => void;
                (mockAnswerFlow.ask as jest.Mock).mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveAnswer = resolve;
                        }),
                );

                const run = command.execute(chatInputs);
                for (let i = 0; i < 10 && !resolveAnswer; i += 1) {
                    await Promise.resolve();
                }

                expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Thinking"));

                resolveAnswer({
                    answer: "Onboarding is documented. [1]",
                    chunks: [{ content: "onboarding docs", score: 0.9, location: "s3://bucket/onboarding.md" }],
                    followUps: [],
                });
                await run;

                expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^\r\s+\r$/));
            } finally {
                Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
                writeSpy.mockRestore();
            }
        });

        it("logs an error and keeps looping when the LLM call throws", async () => {
            (input as jest.Mock).mockResolvedValueOnce("bad query").mockResolvedValueOnce("");
            (mockAnswerFlow.ask as jest.Mock).mockRejectedValueOnce(new Error("No API key found"));

            await expect(command.execute(chatInputs)).resolves.toBeUndefined();

            expect(input).toHaveBeenCalledTimes(2);
        });

        it("exits immediately on blank input without calling the chat service", async () => {
            (input as jest.Mock).mockResolvedValueOnce("");

            await command.execute(chatInputs);

            expect(mockAnswerFlow.ask).not.toHaveBeenCalled();
        });
    });

    describe("mode selection", () => {
        it("rejects combining --chat and --knowledge-base", async () => {
            await expect(command.execute({ chat: true, "knowledge-base": true })).rejects.toThrow(/mutually exclusive/);
            expect(input).not.toHaveBeenCalled();
        });

        it("explains itself when flags are passed but no mode is selected", async () => {
            // A bare `sat-cli onboard` never reaches execute() — the CLI prints the command's
            // help instead — but `--project` on its own does, and must not silently do nothing.
            await expect(command.execute({ project: "Saturam" })).rejects.toThrow(/No mode selected/);
            expect(input).not.toHaveBeenCalled();
            expect(mockAnswerFlow.ask).not.toHaveBeenCalled();
        });

        it("no longer accepts the retired sync flags", () => {
            const names = command.inputs.map((i) => i.name);
            expect(names).toEqual(["project", "knowledge-base", "chat", "new-session"]);
            for (const retired of ["configOrSheet", "project-name", "upload-to-s3", "list", "format", "force"]) {
                expect(names).not.toContain(retired);
            }
        });
    });
});
