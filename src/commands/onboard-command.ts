import { input, select } from "@inquirer/prompts";
import { getLogger } from "log4js";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import * as colors from "yoctocolors-cjs";
import { Service } from "typedi";
import { z } from "zod";
import { KnowledgeBaseChatService } from "../services/knowledge/knowledge-base-chat.service";
import { AnswerFlowService } from "../services/knowledge/answer-flow.service";
import { FollowUp } from "../services/knowledge/agents/follow-up-generator.agent";
import { ConfigService } from "../services/config-service";
import { slugify } from "../utils/slug.util";
import { TypedCommand, TypedInputs } from "./base";

const logger = getLogger("OnboardCommand");

const INPUTS = [
    {
        name: "project",
        description:
            'Limit --knowledge-base retrieval to documents indexed for this project (for example, --project "Saturam"). --chat routes to the right project automatically and ignores this.',
        schema: z.string().optional(),
    },
    {
        name: "knowledge-base",
        description:
            "Interactively ask questions against the configured Bedrock Knowledge Base and print retrieved chunks (Retrieve only — no answer generation). Requires Bedrock Knowledge Base to be configured via 'sat-cli init' → Cloud",
        schema: z.boolean().optional(),
    },
    {
        name: "chat",
        description:
            "Ask questions and get a mentoring answer grounded in the Bedrock Knowledge Base. The project is inferred per question from the documents retrieved; when they span more than one project, the answer is given without a project label rather than asking you to choose. Each answer comes with follow-up questions you can select. Requires both an AI/LLM provider (sat-cli init → AI / LLM providers) and Bedrock Knowledge Base (sat-cli init → Cloud) to be configured",
        schema: z.boolean().optional(),
    },
    {
        name: "new-session",
        description: "Start --chat with a fresh conversation history instead of continuing the previous session",
        schema: z.boolean().optional(),
    },
] as const;

/**
 * Question-answering over the onboarding corpus.
 *
 * This command used to also *build* that corpus — fetching Confluence pages, Jira tickets and
 * Google Drive files, writing them locally, and uploading them to S3 for Bedrock to ingest. That
 * whole side now runs in AWS Lambda (see the `on-boarding` service in sat-cli-internal-infra),
 * on a schedule and off a Google Sheet, so it no longer needs a developer to run it by hand.
 * What is left here is the half a developer actually invokes: asking the indexed corpus questions.
 */
@Service()
export class OnboardCommand implements TypedCommand<typeof INPUTS> {
    readonly name = "onboard";
    readonly description = "Ask questions about your projects, answered from the indexed onboarding documentation";
    readonly category = "common" as const;
    readonly aliases = ["ob", "onboarding"];
    readonly inputs = INPUTS;
    /** Bare `sat-cli onboard` selects no mode, so show the modes rather than exiting silently. */
    readonly helpWhenNoInputs = true;

    constructor(
        private readonly configService: ConfigService,
        private readonly chatService: KnowledgeBaseChatService,
        private readonly answerFlow: AnswerFlowService,
    ) {}

    private static readonly EXCLUSIVE_MODE_FLAGS = ["chat", "knowledge-base"] as const;

    public async execute(inputs: Partial<TypedInputs<typeof INPUTS>>): Promise<void> {
        const activeModes = OnboardCommand.EXCLUSIVE_MODE_FLAGS.filter((flag) => inputs[flag]);
        if (activeModes.length > 1) {
            throw new Error(`--${activeModes.join(", --")} are mutually exclusive — pass only one of them at a time.`);
        }

        if (inputs.chat) {
            if (inputs.project) {
                logger.warn("--project is ignored by --chat: the project is determined automatically per question.");
            }
            await this.runChatSearch(inputs["new-session"]);
            return;
        }

        if (inputs["knowledge-base"]) {
            await this.runKnowledgeBaseSearch(inputs.project);
            return;
        }

        // Reached when flags were passed but no mode was selected (e.g. --project on its own).
        // A bare `sat-cli onboard` never gets here — the CLI prints this command's help instead.
        throw new Error(
            "No mode selected — pass --chat to ask a question, or --knowledge-base to inspect raw retrieval results.",
        );
    }

    private static readonly KB_EXIT_COMMANDS = new Set(["exit", "quit", ":q"]);
    private static readonly LOADING_FRAMES = ["-", "\\", "|", "/"];

    private normalizeProjectName(projectName?: string): string | undefined {
        if (!projectName?.trim()) return undefined;
        return slugify(projectName) || undefined;
    }

    /**
     * Prompts for one question. Returns the trimmed question, or null to signal the REPL
     * should exit — on blank input, "exit"/"quit"/":q", Ctrl+C (inquirer's ExitPromptError), or
     * a non-interactive stdin (a pipe/redirect can't be typed into and, with `terminal: true`
     * forced by inquirer, may hang instead of ever closing).
     */
    private async promptQuestion(message = "Ask Saturam-CLI :"): Promise<string | null> {
        if (!process.stdin.isTTY) {
            logger.error("stdin is not a TTY — this interactive mode requires a terminal.");
            return null;
        }

        let question: string;
        try {
            question = await input({
                message,
                theme: { prefix: { idle: "🤖", done: "🤖" } },
            });
        } catch (err) {
            if (err instanceof Error && err.name === "ExitPromptError") {
                return null;
            }
            throw err;
        }
        const trimmed = typeof question === "string" ? question.trim() : "";
        if (!trimmed || OnboardCommand.KB_EXIT_COMMANDS.has(trimmed.toLowerCase())) {
            return null;
        }
        return trimmed;
    }

    private async withLoading<T>(message: string, task: () => Promise<T>): Promise<T> {
        if (!process.stderr.isTTY) {
            return task();
        }

        let frameIndex = 0;
        const render = () => {
            const frame = OnboardCommand.LOADING_FRAMES[frameIndex % OnboardCommand.LOADING_FRAMES.length];
            process.stderr.write(`\r${frame} ${message}...`);
            frameIndex += 1;
        };

        render();
        const timer = setInterval(render, 120);
        try {
            return await task();
        } finally {
            clearInterval(timer);
            process.stderr.write(`\r${" ".repeat(message.length + 6)}\r`);
        }
    }

    /**
     * Interactive REPL: repeatedly prompts for a question, calls Bedrock Knowledge Base
     * Retrieve (no generation — equivalent to the AWS console's "Retrieve only" test mode),
     * and prints the ranked chunks. Exits on blank input, "exit"/"quit", or Ctrl+C.
     */
    private async runKnowledgeBaseSearch(projectName?: string): Promise<void> {
        const project = this.normalizeProjectName(projectName);
        logger.info("Bedrock Knowledge Base search (Retrieve only — no answer generation).");
        if (project) logger.info(`Project filter: ${project}`);
        logger.info("Type a question and press Enter. Type 'exit' or leave blank to quit.\n");

        for (;;) {
            const question = await this.promptQuestion();
            if (question === null) {
                logger.info("Exiting knowledge base search.");
                return;
            }

            try {
                const results = await this.withLoading("Retrieving matching knowledge base chunks", () =>
                    this.chatService.search(question, { project }),
                );
                if (results.length === 0) {
                    logger.info("No matching results found.\n");
                    continue;
                }

                logger.info(`\nFound ${results.length} result(s):`);
                results.forEach((result, index) => {
                    const scoreText = result.score !== undefined ? ` (score: ${result.score.toFixed(3)})` : "";
                    logger.info(`\n${index + 1}.${scoreText}`);
                    if (result.location) logger.info(`   source: ${result.location}`);
                    if (result.metadata && Object.keys(result.metadata).length > 0) {
                        logger.info(`   metadata: ${JSON.stringify(result.metadata)}`);
                    }
                    logger.info(`   ${result.content.trim()}`);
                });
                logger.info("");
            } catch (err) {
                logger.error(`Retrieval failed: ${(err as Error).message}\n`);
            }
        }
    }

    /**
     * Removes inline citation markers like "[1]" or "[1, 2]" from an answer.
     *
     * Citations are indistinguishable from array indices (`x[1]`) and list literals (`[1, 2, 3]`)
     * by shape alone, and mentor answers routinely contain code examples. So the answer is split
     * into code and prose segments and only prose is stripped, with a further guard that a marker
     * directly attached to an identifier is an index, never a citation.
     */
    private stripInlineCitations(answer: string): string {
        // Odd-indexed segments are the captured code spans (fenced blocks or inline code).
        return answer
            .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
            .map((segment, index) =>
                index % 2 === 1
                    ? segment
                    : // The lookbehind sits at the bracket, not before the whitespace: a citation
                      // is separated from the preceding word ("applies [1]"), while an index is
                      // attached to it ("x[1]", "fn()[1]").
                      segment.replace(/\s*(?<![\w\])])\[\d+(?:\s*,\s*\d+)*\]/g, ""),
            )
            .join("");
    }

    /**
     * Built lazily on first use (and re-built if the terminal is resized) instead of at module
     * load — most commands never render an answer, and process.stdout.columns at import time
     * doesn't reflect the terminal's actual current width (e.g. after a resize).
     */
    private terminalMarkdown?: { renderer: Marked; width: number };

    private getTerminalMarkdown(): Marked {
        const width = process.stdout.columns || 100;
        if (!this.terminalMarkdown || this.terminalMarkdown.width !== width) {
            this.terminalMarkdown = {
                // marked-terminal's defaults already colour headings, code and links. The one
                // override is the blockquote: an answer that quotes a document should read as a
                // different voice, and the default gray italic disappears on a dark terminal.
                renderer: new Marked(
                    markedTerminal({ width, reflowText: false, blockquote: (text: string) => colors.yellow(text) }),
                ),
                width,
            };
        }
        return this.terminalMarkdown.renderer;
    }

    private renderAnswer(answer: string): string {
        const cleaned = this.stripInlineCitations(answer).trim();
        if (!process.stdout.isTTY) {
            return cleaned;
        }
        return String(this.getTerminalMarkdown().parse(cleaned)).trimEnd();
    }

    private printSources(chunks: Array<{ location?: string; metadata?: Record<string, unknown> }>): void {
        // Prefer the original document URL (Confluence/Jira/Drive) carried in the metadata
        // sidecar the ingestion pipeline uploaded alongside the content — `location` is the S3 URI
        // Bedrock ingested from, which isn't something a person can usefully open.
        const sources = Array.from(
            new Set(
                chunks
                    .map((chunk) => {
                        const metadataUrl = chunk.metadata?.url;
                        return (typeof metadataUrl === "string" && metadataUrl) || chunk.location;
                    })
                    .filter(Boolean),
            ),
        );
        if (sources.length === 0) return;

        // Dimmed: sources are for checking, not reading, and a dozen full-brightness URLs after
        // every answer otherwise compete with the answer itself for the eye.
        logger.info(colors.dim("Sources:"));
        sources.forEach((source) => logger.info(colors.dim(`- ${source}`)));
        logger.info("");
    }

    /**
     * Interactive mentoring chat.
     *
     * Each question goes to the mentor agent, which searches the Knowledge Base until it can
     * answer, and comes back with follow-up suggestions the user can select to continue. The
     * project is read off the retrieved evidence, never asked for.
     */
    private async runChatSearch(newSession?: boolean): Promise<void> {
        const hasLlm = await this.configService.hasAnyLLMProviderConfigured();
        if (!hasLlm) {
            logger.warn("No AI/LLM provider is configured yet.");
            logger.info(
                "Run 'sat-cli init' and select 'AI / LLM providers' to configure one (Anthropic, OpenAI, Gemini, Bedrock, etc.), then try 'sat-cli onboard --chat' again.",
            );
            return;
        }

        if (newSession) {
            this.answerFlow.startNewSession();
            logger.info("Started a new conversation.");
        }

        logger.info("Ask about any indexed project, or a general engineering question.");
        logger.info("Type 'exit' or leave blank to quit.\n");

        // Set when the user picks a suggested follow-up, so the next iteration skips the prompt.
        let queuedQuestion: string | undefined;

        for (;;) {
            const question = queuedQuestion ?? (await this.promptQuestion());
            queuedQuestion = undefined;
            if (question === null || question === undefined) {
                logger.info("Exiting.");
                return;
            }

            try {
                const result = await this.withLoading("Thinking", () => this.answerFlow.ask(question));

                if (result.project) logger.info(`\n${colors.bold(colors.cyan(`[${result.project.displayName}]`))}`);
                logger.info(`\n${this.renderAnswer(result.answer)}\n`);
                this.printSources(result.chunks);

                const next = await this.promptFollowUp(result.followUps);
                if (next === null) {
                    logger.info("Exiting.");
                    return;
                }
                queuedQuestion = next;
            } catch (err) {
                logger.error(`Chat failed: ${(err as Error).message}\n`);
            }
        }
    }

    /**
     * Offers the generated follow-ups as selectable options. Returns the chosen question, or
     * undefined to fall back to a free-text prompt, or null to exit.
     */
    private async promptFollowUp(followUps: FollowUp[], message = "What next?"): Promise<string | undefined | null> {
        if (followUps.length === 0 || !process.stdin.isTTY) return undefined;

        const ASK_OWN = "__ask_own__";
        const EXIT = "__exit__";

        try {
            const choice = await select<string>({
                message,
                choices: [
                    ...followUps.map((followUp) => ({ name: followUp.question, value: followUp.question })),
                    { name: "Let me put it another way", value: ASK_OWN },
                    { name: "Exit", value: EXIT },
                ],
                pageSize: followUps.length + 2,
            });

            if (choice === EXIT) return null;
            if (choice === ASK_OWN) return undefined;
            return choice;
        } catch (err) {
            // Ctrl+C at the follow-up picker ends the session, matching the question prompt.
            if (err instanceof Error && err.name === "ExitPromptError") return null;
            throw err;
        }
    }
}
