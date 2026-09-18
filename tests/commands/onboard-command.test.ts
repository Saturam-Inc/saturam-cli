import { input, select } from "@inquirer/prompts";
import { OnboardCommand } from "../../src/commands/onboard-command";
import { OnboardService } from "../../src/services/onboarding/onboard.service";
import { ConfigService } from "../../src/services/config-service";
import { OnboardingConfigService } from "../../src/services/onboarding/onboarding-config.service";
import { KnowledgeBaseChatService } from "../../src/services/knowledge/knowledge-base-chat.service";
import { AnswerFlowService } from "../../src/services/knowledge/answer-flow.service";
import { WorkingDirectory } from "../../src/utils/working-directory";

jest.mock("@inquirer/prompts", () => ({
    input: jest.fn(),
    select: jest.fn(),
}));

describe("OnboardCommand Dual-Mode Routing", () => {
    let command: OnboardCommand;
    let mockOnboardService: jest.Mocked<OnboardService>;
    let mockConfigService: jest.Mocked<ConfigService>;
    let mockOnboardingConfig: jest.Mocked<OnboardingConfigService>;
    let mockChatService: jest.Mocked<KnowledgeBaseChatService>;
    let mockAnswerFlow: jest.Mocked<AnswerFlowService>;
    let dir: WorkingDirectory;
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
        mockOnboardService = {
            sync: jest.fn().mockResolvedValue({ filesWritten: [], fetched: 1, failed: 0 }),
            uploadToS3: jest.fn().mockResolvedValue({ uploaded: 0, skipped: 0, failed: 0 }),
            listSyncedDocuments: jest.fn().mockResolvedValue(undefined),
            resolveConfigFromSheet: jest
                .fn()
                .mockImplementation((spreadsheetId: string) =>
                    Promise.resolve({ onboardingSheets: [{ spreadsheetId }] }),
                ),
        } as any;

        mockConfigService = {
            loadOnboardingConfig: jest.fn().mockResolvedValue({
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            }),
            hasAnyLLMProviderConfigured: jest.fn().mockResolvedValue(true),
            getOnboardingSheetId: jest.fn().mockResolvedValue(undefined),
            setOnboardingSheetId: jest.fn().mockResolvedValue(undefined),
        } as any;

        mockOnboardingConfig = {
            configPath: "/mock/repo/.sateng/onboarding.json",
            localConfigExists: jest.fn().mockReturnValue(false),
            isLocalConfigHandWritten: jest.fn().mockReturnValue(false),
            resolveConfigArgPath: jest.fn().mockImplementation((arg: string) => `/mock/cwd/${arg}`),
            parseSheetArg: jest.fn().mockImplementation((arg: string) => {
                if (arg.includes("docs.google.com/spreadsheets")) {
                    return arg.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? null;
                }
                return /^[a-zA-Z0-9-_]{44}$/.test(arg) ? arg : null;
            }),
            saveResolvedConfig: jest.fn(),
            writeSampleConfig: jest.fn(),
        } as any;

        mockAnswerFlow = {
            startNewSession: jest.fn(),
            ask: jest.fn().mockResolvedValue({
                answer: "an answer",
                chunks: [],
                followUps: [],
                intent: "project_knowledge",
                cancelled: false,
            }),
        } as any;

        mockChatService = {
            search: jest.fn().mockResolvedValue([]),
            ask: jest.fn().mockResolvedValue({ answer: "Here is the answer.", chunks: [] }),
        } as any;

        dir = new WorkingDirectory("/mock/cwd", "/mock/cli", "/mock/repo");

        command = new OnboardCommand(
            mockOnboardService,
            mockConfigService,
            mockOnboardingConfig,
            mockChatService,
            mockAnswerFlow,
            dir,
        );
    });

    it("should route to Google Sheet mode when passed a Google Sheets URL", async () => {
        await command.execute({
            configOrSheet: "https://docs.google.com/spreadsheets/d/1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg/edit",
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            dir.cwd,
            undefined,
        );
    });

    it("should route to Google Sheet mode when passed a 44-character Google Sheet ID", async () => {
        await command.execute({
            configOrSheet: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg",
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            dir.cwd,
            undefined,
        );
    });

    it("should default to local config mode when no argument is passed", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith(mockOnboardingConfig.configPath);
        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            },
            dir.cwd,
            undefined,
        );
    });

    it("should pass the --project-name override through to OnboardService.sync in config mode", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": "custom-project",
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            },
            dir.cwd,
            "custom-project",
        );
    });

    it("should pass the --project-name override through to OnboardService.sync in Google Sheet mode", async () => {
        await command.execute({
            configOrSheet: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg",
            "project-name": "custom-project",
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            dir.cwd,
            "custom-project",
        );
    });

    it("should call uploadToS3 with the files written when --upload-to-s3 is passed", async () => {
        const filesWritten = [
            {
                contentPath: "/mock/onboarding/saturam/google-docs/doc.md",
                metadataAttributes: { title: "Doc", category: "google-docs", project: "saturam" },
            },
        ];
        (mockOnboardService.sync as jest.Mock).mockResolvedValue({ filesWritten, fetched: 1, failed: 0 });

        await command.execute({
            configOrSheet: undefined,
            "project-name": "Saturam",
            "upload-to-s3": true,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.uploadToS3).toHaveBeenCalledWith(filesWritten);
    });

    it("should not call uploadToS3 when --upload-to-s3 is not passed", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.uploadToS3).not.toHaveBeenCalled();
    });

    it("sets a non-zero exit code when every document fails to sync", async () => {
        const originalExitCode = process.exitCode;
        (mockOnboardService.sync as jest.Mock).mockResolvedValue({ filesWritten: [], fetched: 0, failed: 3 });

        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(process.exitCode).toBe(1);
        process.exitCode = originalExitCode;
    });

    it("should route to listSyncedDocuments and skip syncing when --list is passed", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: true,
            "knowledge-base": undefined,
            chat: undefined,
        });

        expect(mockOnboardService.listSyncedDocuments).toHaveBeenCalledTimes(1);
        expect(mockOnboardService.sync).not.toHaveBeenCalled();
        expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
    });

    describe("--knowledge-base interactive search", () => {
        it("exits immediately without prompting when stdin is not a TTY", async () => {
            Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
            try {
                await command.execute({
                    configOrSheet: undefined,
                    "project-name": undefined,
                    "upload-to-s3": undefined,
                    list: undefined,
                    "knowledge-base": true,
                    chat: undefined,
                });
            } finally {
                Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
            }

            expect(input).not.toHaveBeenCalled();
            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("skips syncing entirely and enters the search loop", async () => {
            (input as jest.Mock).mockResolvedValueOnce("");

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
                chat: undefined,
            });

            expect(mockOnboardService.sync).not.toHaveBeenCalled();
            expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
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

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
                chat: undefined,
            });

            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("exits on 'exit' or 'quit' (case-insensitive)", async () => {
            (input as jest.Mock).mockResolvedValueOnce("EXIT");

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
                chat: undefined,
            });

            expect(mockChatService.search).not.toHaveBeenCalled();
        });

        it("treats Ctrl+C as a normal exit", async () => {
            const exitError = new Error("User force closed the prompt");
            exitError.name = "ExitPromptError";
            (input as jest.Mock).mockRejectedValueOnce(exitError);

            await expect(
                command.execute({
                    configOrSheet: undefined,
                    "project-name": undefined,
                    "upload-to-s3": undefined,
                    list: undefined,
                    "knowledge-base": true,
                    chat: undefined,
                }),
            ).resolves.toBeUndefined();

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

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
                chat: undefined,
            });

            expect(mockChatService.search).toHaveBeenCalledTimes(2);
            expect(mockChatService.search).toHaveBeenNthCalledWith(1, "what is the auth flow?", {
                project: undefined,
            });
            expect(mockChatService.search).toHaveBeenNthCalledWith(2, "what is onboarding?", { project: undefined });
        });

        it("logs an error and keeps looping when retrieve throws", async () => {
            (input as jest.Mock).mockResolvedValueOnce("bad query").mockResolvedValueOnce("");
            (mockChatService.search as jest.Mock).mockRejectedValueOnce(new Error("KB not configured"));

            await expect(
                command.execute({
                    configOrSheet: undefined,
                    "project-name": undefined,
                    "upload-to-s3": undefined,
                    list: undefined,
                    "knowledge-base": true,
                    chat: undefined,
                }),
            ).resolves.toBeUndefined();

            expect(input).toHaveBeenCalledTimes(2);
        });
    });

    describe("--chat RAG search", () => {
        const chatInputs = {
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: true,
        };

        it("shows a setup suggestion and skips everything else when no LLM provider is configured", async () => {
            (mockConfigService.hasAnyLLMProviderConfigured as jest.Mock).mockResolvedValue(false);

            await command.execute(chatInputs);

            expect(input).not.toHaveBeenCalled();
            expect(mockAnswerFlow.ask).not.toHaveBeenCalled();
            expect(mockOnboardService.sync).not.toHaveBeenCalled();
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
                intent: "project_knowledge",
                cancelled: false,
            });

            try {
                await command.execute(chatInputs);
            } finally {
                Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });
            }

            expect(mockAnswerFlow.ask).toHaveBeenCalledWith(
                "what is the auth flow?",
                expect.anything(),
                expect.anything(),
            );
            expect((command as any).renderAnswer("The auth flow uses OAuth2. [1]")).toBe("The auth flow uses OAuth2.");
        });

        it("ignores --project, since the flow determines the project per question", async () => {
            (input as jest.Mock).mockResolvedValueOnce("give me the overview").mockResolvedValueOnce("");

            await command.execute({ ...chatInputs, project: "Saturam Core" });

            // The question reaches the flow unscoped: routing is automatic, and a stale manual
            // filter silently returning nothing is the failure mode the redesign removes.
            expect(mockAnswerFlow.ask).toHaveBeenCalledWith(
                "give me the overview",
                expect.anything(),
                expect.anything(),
            );
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
                    intent: "project_knowledge",
                    cancelled: false,
                })
                .mockResolvedValueOnce({
                    answer: "It retries with backoff.",
                    chunks: [],
                    followUps: [],
                    intent: "project_knowledge",
                    cancelled: false,
                });
            (select as jest.Mock).mockResolvedValueOnce("How does the sync handle failures?");

            await command.execute(chatInputs);

            expect(mockAnswerFlow.ask).toHaveBeenNthCalledWith(
                2,
                "How does the sync handle failures?",
                expect.anything(),
                expect.anything(),
            );
        });

        it("skips printing an answer when the user chose to rephrase at the project picker", async () => {
            (input as jest.Mock).mockResolvedValueOnce("how do refunds work?").mockResolvedValueOnce("");
            (mockAnswerFlow.ask as jest.Mock).mockResolvedValueOnce({
                answer: "",
                chunks: [],
                followUps: [],
                intent: "project_knowledge",
                cancelled: true,
            });

            await command.execute(chatInputs);

            // Cancelling returns to the prompt rather than ending the session.
            expect(input).toHaveBeenCalledTimes(2);
            expect(select).not.toHaveBeenCalled();
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
                    intent: "project_knowledge",
                    cancelled: false,
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

    describe("--format sample config generation", () => {
        it("delegates to OnboardingConfigService and skips syncing", async () => {
            await command.execute({ format: true } as any);

            expect(mockOnboardingConfig.writeSampleConfig).toHaveBeenCalledTimes(1);
            expect(mockOnboardService.sync).not.toHaveBeenCalled();
        });
    });

    describe("--forget-sheet", () => {
        it("clears the remembered onboarding sheet and skips syncing", async () => {
            await command.execute({ "forget-sheet": true } as any);

            expect(mockConfigService.setOnboardingSheetId).toHaveBeenCalledWith(undefined);
            expect(mockOnboardService.sync).not.toHaveBeenCalled();
        });
    });

    describe("mutually exclusive mode flags", () => {
        it("rejects combining two mode flags instead of silently picking one", async () => {
            await expect(command.execute({ format: true, list: true } as any)).rejects.toThrow(/mutually exclusive/);
            expect(mockOnboardingConfig.writeSampleConfig).not.toHaveBeenCalled();
            expect(mockOnboardService.listSyncedDocuments).not.toHaveBeenCalled();
        });

        it("rejects combining --chat and --knowledge-base", async () => {
            await expect(command.execute({ chat: true, "knowledge-base": true } as any)).rejects.toThrow(
                /mutually exclusive/,
            );
        });
    });

    describe("Google Sheet mode — mirroring the resolved config to onboarding.json", () => {
        const SHEET_ID = "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg";
        const structuredConfig = {
            confluence: { baseUrl: "https://saturam.atlassian.net" },
            projects: { Saturam: { jira: { tickets: ["PROJ-1"] } } },
        };

        it("syncs first, then mirrors the resolved config and remembers the sheet ID only after a successful sync", async () => {
            (mockOnboardService.resolveConfigFromSheet as jest.Mock).mockResolvedValue(structuredConfig);

            await command.execute({
                configOrSheet: SHEET_ID,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardService.sync).toHaveBeenCalledWith(structuredConfig, dir.cwd, undefined);
            expect(mockOnboardingConfig.saveResolvedConfig).toHaveBeenCalledWith(structuredConfig, SHEET_ID, undefined);
            expect(mockConfigService.setOnboardingSheetId).toHaveBeenCalledWith(SHEET_ID);

            // Ordering: sync() happens before the mirror/remember, so a failed sync never installs one.
            const syncOrder = (mockOnboardService.sync as jest.Mock).mock.invocationCallOrder[0];
            const saveOrder = (mockOnboardingConfig.saveResolvedConfig as jest.Mock).mock.invocationCallOrder[0];
            expect(syncOrder).toBeLessThan(saveOrder);
        });

        it("does not mirror onboarding.json or remember the sheet ID when the sheet has no project_name column (sheet-of-links fallback)", async () => {
            const fallbackConfig = { onboardingSheets: [{ spreadsheetId: SHEET_ID }] };
            (mockOnboardService.resolveConfigFromSheet as jest.Mock).mockResolvedValue(fallbackConfig);

            await command.execute({
                configOrSheet: SHEET_ID,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardingConfig.saveResolvedConfig).not.toHaveBeenCalled();
            expect(mockConfigService.setOnboardingSheetId).not.toHaveBeenCalled();
        });

        it("does not mirror or remember the sheet ID when the sync fails", async () => {
            (mockOnboardService.resolveConfigFromSheet as jest.Mock).mockResolvedValue(structuredConfig);
            (mockOnboardService.sync as jest.Mock).mockRejectedValue(new Error("network error"));

            await expect(
                command.execute({
                    configOrSheet: SHEET_ID,
                    "project-name": undefined,
                    "upload-to-s3": undefined,
                    list: undefined,
                    "knowledge-base": undefined,
                    chat: undefined,
                }),
            ).rejects.toThrow("network error");

            expect(mockOnboardingConfig.saveResolvedConfig).not.toHaveBeenCalled();
            expect(mockConfigService.setOnboardingSheetId).not.toHaveBeenCalled();
        });

        it("re-checks the remembered sheet (from the personal config) when 'sat-cli onboard' is run with no argument and no local config exists", async () => {
            (mockConfigService.getOnboardingSheetId as jest.Mock).mockResolvedValue(SHEET_ID);
            (mockOnboardingConfig.localConfigExists as jest.Mock).mockReturnValue(false);
            (mockOnboardingConfig.isLocalConfigHandWritten as jest.Mock).mockReturnValue(false);
            const freshConfig = {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
                projects: { Saturam: { jira: { tickets: ["NEW-1", "NEW-2"] } } },
            };
            (mockOnboardService.resolveConfigFromSheet as jest.Mock).mockResolvedValue(freshConfig);

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardService.resolveConfigFromSheet).toHaveBeenCalledWith(SHEET_ID);
            expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
            expect(mockOnboardService.sync).toHaveBeenCalledWith(freshConfig, dir.cwd, undefined);
        });

        it("still re-checks the remembered sheet even when a local onboarding.json already exists, as long as it's sheet-derived (a cache, not hand-written)", async () => {
            (mockConfigService.getOnboardingSheetId as jest.Mock).mockResolvedValue(SHEET_ID);
            (mockOnboardingConfig.localConfigExists as jest.Mock).mockReturnValue(true);
            (mockOnboardingConfig.isLocalConfigHandWritten as jest.Mock).mockReturnValue(false);
            const freshConfig = {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
                projects: { Saturam: { jira: { tickets: ["NEW-1", "NEW-2"] } } },
            };
            (mockOnboardService.resolveConfigFromSheet as jest.Mock).mockResolvedValue(freshConfig);

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardService.resolveConfigFromSheet).toHaveBeenCalledWith(SHEET_ID);
            expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
            expect(mockOnboardService.sync).toHaveBeenCalledWith(freshConfig, dir.cwd, undefined);
        });

        it("prefers a hand-written local .sateng/onboarding.json over a remembered sheet from an unrelated project", async () => {
            (mockConfigService.getOnboardingSheetId as jest.Mock).mockResolvedValue(SHEET_ID);
            (mockOnboardingConfig.localConfigExists as jest.Mock).mockReturnValue(true);
            (mockOnboardingConfig.isLocalConfigHandWritten as jest.Mock).mockReturnValue(true);

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardService.resolveConfigFromSheet).not.toHaveBeenCalled();
            expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith(mockOnboardingConfig.configPath);
        });

        it("falls back to the local sheet-derived cache when re-checking the remembered sheet fails", async () => {
            (mockConfigService.getOnboardingSheetId as jest.Mock).mockResolvedValue(SHEET_ID);
            (mockOnboardingConfig.localConfigExists as jest.Mock).mockReturnValue(true);
            (mockOnboardingConfig.isLocalConfigHandWritten as jest.Mock).mockReturnValue(false);
            (mockOnboardService.resolveConfigFromSheet as jest.Mock).mockRejectedValue(new Error("token expired"));

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith(mockOnboardingConfig.configPath);
        });

        it("does not re-check a remembered sheet when an explicit config path is passed, even if one is remembered", async () => {
            (mockConfigService.getOnboardingSheetId as jest.Mock).mockResolvedValue(SHEET_ID);

            await command.execute({
                configOrSheet: "./custom-onboarding.json",
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardService.resolveConfigFromSheet).not.toHaveBeenCalled();
            expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith("/mock/cwd/./custom-onboarding.json");
        });

        it("loads .sateng/onboarding.json as a plain local config when no sheet ID is remembered", async () => {
            (mockConfigService.getOnboardingSheetId as jest.Mock).mockResolvedValue(undefined);

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": undefined,
                chat: undefined,
            });

            expect(mockOnboardService.resolveConfigFromSheet).not.toHaveBeenCalled();
            expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith(mockOnboardingConfig.configPath);
        });
    });
});
