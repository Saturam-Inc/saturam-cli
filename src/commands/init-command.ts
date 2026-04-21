import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { LLMModel } from "../constants/llm-models";
import {
    AIProvider,
    ConfigService,
    KEYLESS_PROVIDERS,
    PersonalConfiguration,
    ProviderConfig,
    PROVIDER_ENV_VARS,
    PROVIDER_MODELS,
} from "../services/config-service";
import { TypedCommand, TypedInputs } from "./base";

const logger = getLogger("InitCommand");

const INPUTS = [] as const;

const PROVIDER_DISPLAY_NAMES: Record<AIProvider, string> = {
    [AIProvider.ANTHROPIC]: "Anthropic (Claude)",
    [AIProvider.BEDROCK]: "AWS Bedrock (Claude, Nova)",
    [AIProvider.OPENAI]: "OpenAI (GPT)",
    [AIProvider.GOOGLE]: "Google (Gemini)",
    [AIProvider.XAI]: "xAI (Grok)",
    [AIProvider.DEEPSEEK]: "DeepSeek",
    [AIProvider.OLLAMA]: "Ollama (local models)",
};

const MODEL_DISPLAY_NAMES: Record<LLMModel, string> = {
    // Anthropic
    [LLMModel.ANTHROPIC_CLAUDE_4_SONNET]: "Claude 4 Sonnet (latest)",
    [LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET]: "Claude 4.5 Sonnet",
    [LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS]: "Claude 4.6 Opus (1M context)",
    // Bedrock
    [LLMModel.BEDROCK_CLAUDE_4_SONNET]: "Bedrock Claude 4 Sonnet",
    [LLMModel.BEDROCK_CLAUDE_4_5_SONNET]: "Bedrock Claude 4.5 Sonnet",
    [LLMModel.BEDROCK_CLAUDE_4_6_OPUS]: "Bedrock Claude 4.6 Opus",
    [LLMModel.BEDROCK_NOVA_PRO]: "Amazon Nova Pro",
    // Gemini
    [LLMModel.GEMINI_2_5_PRO]: "Gemini 2.5 Pro",
    [LLMModel.GEMINI_2_5_FLASH]: "Gemini 2.5 Flash",
    [LLMModel.GEMINI_3_PRO]: "Gemini 3 Pro",
    [LLMModel.GEMINI_3_FLASH]: "Gemini 3 Flash",
    // OpenAI
    [LLMModel.OPENAI_GPT_4O]: "GPT-4o",
    [LLMModel.OPENAI_GPT_5]: "GPT-5",
    [LLMModel.OPENAI_O3_MINI]: "o3-mini",
    // Grok
    [LLMModel.GROK_2]: "Grok 2",
    // DeepSeek
    [LLMModel.DEEPSEEK_CHAT]: "DeepSeek Chat",
    [LLMModel.DEEPSEEK_REASONER]: "DeepSeek Reasoner",
    // Ollama
    [LLMModel.OLLAMA_LLAMA3]: "Llama 3 (8B)",
    [LLMModel.OLLAMA_LLAMA3_1]: "Llama 3.1 (8B, 128K context)",
    [LLMModel.OLLAMA_LLAMA3_2]: "Llama 3.2 (3B, 128K context)",
    [LLMModel.OLLAMA_CODELLAMA]: "Code Llama",
    [LLMModel.OLLAMA_MISTRAL]: "Mistral (7B)",
    [LLMModel.OLLAMA_MIXTRAL]: "Mixtral (8x7B)",
    [LLMModel.OLLAMA_DEEPSEEK_CODER_V2]: "DeepSeek Coder V2",
    [LLMModel.OLLAMA_QWEN2_5_CODER]: "Qwen 2.5 Coder",
    [LLMModel.OLLAMA_GEMMA2]: "Gemma 2",
    [LLMModel.OLLAMA_PHI3]: "Phi-3 (128K context)",
    [LLMModel.OLLAMA_CUSTOM]: "Custom model (specify name)",
};

@Service()
export class InitCommand implements TypedCommand<typeof INPUTS> {
    readonly name = "init";
    readonly description = "Initialize sateng CLI — configure AI providers, API keys, and default model";
    readonly category = "common" as const;
    readonly aliases = ["i", "setup"];
    readonly inputs = INPUTS;

    constructor(private readonly config: ConfigService) {}

    public async execute(_inputs: TypedInputs<typeof INPUTS>): Promise<void> {
        logger.info("Welcome to Saturam Engineering CLI setup!\n");

        const existing = await this.config.loadPersonalConfig();
        const hasExisting = Object.keys(existing.providers ?? {}).length > 0;

        if (hasExisting) {
            logger.info("Existing configuration found:");
            this.printCurrentConfig(existing);
            logger.info("");

            const action = await select({
                message: "What would you like to do?",
                choices: [
                    { name: "Reconfigure everything", value: "reconfigure" },
                    { name: "Add/update an AI provider", value: "add" },
                    { name: "Change default model", value: "model" },
                    { name: "Configure SCM platforms (GitHub/Bitbucket/GitLab)", value: "scm" },
                    { name: "Exit", value: "exit" },
                ],
            });

            if (action === "exit") return;
            if (action === "model") {
                await this.selectDefaultModel(existing);
                return;
            }
            if (action === "add") {
                await this.addProvider(existing);
                return;
            }
            if (action === "scm") {
                const scmConfig = await this.configureSCMPlatforms(existing);
                await this.config.savePersonalConfig({ ...existing, ...scmConfig });
                logger.info("\nSCM configuration saved.");
                return;
            }
            // reconfigure falls through
        }

        // Full setup
        const config = await this.fullSetup(existing);
        await this.config.savePersonalConfig(config);

        logger.info("\n--- Configuration saved ---");
        logger.info(`Config file: ${this.config.getPersonalConfigPath()}`);
        this.printCurrentConfig(config);
        logger.info("\nRun 'sat-cli review' to try it out!");
    }

    private async fullSetup(existing: PersonalConfiguration): Promise<PersonalConfiguration> {
        // Step 1: Select providers
        const selectedProviders = await checkbox({
            message: "Which AI providers do you want to configure?",
            choices: Object.values(AIProvider).map((p) => ({
                name: PROVIDER_DISPLAY_NAMES[p],
                value: p,
                checked: !!existing.providers?.[p],
            })),
            required: true,
        });

        // Step 2: Configure each provider
        const providers: PersonalConfiguration["providers"] = {};
        for (const provider of selectedProviders) {
            providers[provider] = await this.configureProvider(provider, existing.providers?.[provider]);
        }

        // Step 3: Select default provider and model
        const defaultProvider = selectedProviders.length === 1
            ? selectedProviders[0]
            : await select({
                  message: "Which provider should be the default?",
                  choices: selectedProviders.map((p) => ({
                      name: PROVIDER_DISPLAY_NAMES[p],
                      value: p,
                  })),
              });

        const defaultModel = await this.promptForModel(defaultProvider, providers[defaultProvider]);

        // Step 4: SCM platforms (GitHub, Bitbucket)
        const scmConfig = await this.configureSCMPlatforms(existing);

        return {
            defaultProvider,
            defaultModel,
            providers,
            ...scmConfig,
        };
    }

    private async configureProvider(provider: AIProvider, existing?: ProviderConfig): Promise<ProviderConfig> {
        logger.info(`\nConfiguring ${PROVIDER_DISPLAY_NAMES[provider]}...`);

        if (provider === AIProvider.BEDROCK) {
            return this.configureBedrockProvider(existing);
        }

        if (provider === AIProvider.OLLAMA) {
            return this.configureOllamaProvider(existing);
        }

        // Standard API key provider
        const apiKey = await this.promptForApiKey(provider, existing?.apiKey);
        return { apiKey, enabled: true };
    }

    private async configureBedrockProvider(existing?: ProviderConfig): Promise<ProviderConfig> {
        logger.info("Bedrock uses your AWS credentials (no API key needed).");

        const awsProfile = await input({
            message: "AWS CLI profile name (leave empty for default credential chain):",
            default: existing?.awsProfile ?? process.env.AWS_PROFILE ?? "",
        });

        const awsRegion = await input({
            message: "AWS region:",
            default: existing?.awsRegion ?? process.env.AWS_REGION ?? "us-east-1",
        });

        // Verify AWS credentials if profile given
        if (awsProfile) {
            try {
                const { execSync } = require("child_process");
                execSync(`aws sts get-caller-identity --profile ${awsProfile}`, { stdio: "pipe" });
                logger.info(`AWS profile '${awsProfile}' verified successfully.`);
            } catch {
                logger.warn(`Warning: Could not verify AWS profile '${awsProfile}'. Make sure it's configured.`);
            }
        }

        return {
            enabled: true,
            awsProfile: awsProfile || undefined,
            awsRegion,
        };
    }

    private async configureOllamaProvider(existing?: ProviderConfig): Promise<ProviderConfig> {
        const defaultUrl = existing?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

        const baseUrl = await input({
            message: "Ollama server URL:",
            default: defaultUrl,
        });

        // Detect locally available models
        let detectedModels: string[] = [];
        try {
            const response = await fetch(`${baseUrl}/api/tags`);
            if (response.ok) {
                const data = (await response.json()) as { models?: Array<{ name: string }> };
                detectedModels = (data.models ?? []).map((m) => m.name);
                if (detectedModels.length > 0) {
                    logger.info(`Ollama is running with ${detectedModels.length} model(s): ${detectedModels.join(", ")}`);
                } else {
                    logger.warn("Ollama is running but no models are pulled. Run 'ollama pull <model>' to download one.");
                }
            }
        } catch {
            logger.warn(`Warning: Could not connect to Ollama at ${baseUrl}. Make sure it's running.`);
        }

        return {
            enabled: true,
            baseUrl,
            detectedModels: detectedModels.length > 0 ? detectedModels : undefined,
        };
    }

    private async addProvider(existing: PersonalConfiguration): Promise<void> {
        const allProviders = Object.values(AIProvider);

        const provider = await select({
            message: "Select a provider to add or update:",
            choices: allProviders.map((p) => ({
                name: `${PROVIDER_DISPLAY_NAMES[p]}${existing.providers?.[p] ? " (configured)" : ""}`,
                value: p,
            })),
        });

        const providerConfig = await this.configureProvider(provider, existing.providers?.[provider]);
        const providers = { ...existing.providers, [provider]: providerConfig };
        const config: PersonalConfiguration = { ...existing, providers };
        await this.config.savePersonalConfig(config);

        logger.info(`\n${PROVIDER_DISPLAY_NAMES[provider]} configured successfully.`);

        // Offer to switch default if this is a new provider
        if (!existing.providers?.[provider]) {
            const switchDefault = await confirm({
                message: `Set ${PROVIDER_DISPLAY_NAMES[provider]} as the default provider?`,
                default: false,
            });
            if (switchDefault) {
                const model = await this.promptForModel(provider, providerConfig);
                await this.config.savePersonalConfig({ ...config, defaultProvider: provider, defaultModel: model });
                logger.info(`Default set to ${MODEL_DISPLAY_NAMES[model]}.`);
            }
        }
    }

    private async selectDefaultModel(existing: PersonalConfiguration): Promise<void> {
        const configuredProviders = Object.entries(existing.providers ?? {})
            .filter(([, v]) => v.enabled)
            .map(([k]) => k as AIProvider);

        if (configuredProviders.length === 0) {
            logger.info("No providers configured. Run 'sat-cli init' to set up providers first.");
            return;
        }

        const provider = configuredProviders.length === 1
            ? configuredProviders[0]
            : await select({
                  message: "Select the provider:",
                  choices: configuredProviders.map((p) => ({
                      name: PROVIDER_DISPLAY_NAMES[p],
                      value: p,
                  })),
              });

        const model = await this.promptForModel(provider, existing.providers?.[provider]);
        const config: PersonalConfiguration = {
            ...existing,
            defaultProvider: provider,
            defaultModel: model,
        };
        await this.config.savePersonalConfig(config);
        logger.info(`\nDefault model set to ${MODEL_DISPLAY_NAMES[model]}.`);
    }

    private async promptForModel(provider: AIProvider, providerConfig?: ProviderConfig): Promise<LLMModel> {
        // For Ollama, build a smarter list
        if (provider === AIProvider.OLLAMA) {
            return this.promptForOllamaModel(providerConfig);
        }

        const models = PROVIDER_MODELS[provider];
        const choices = models.map((m) => ({
            name: MODEL_DISPLAY_NAMES[m],
            value: m,
        }));

        return select({
            message: "Select your default model:",
            choices,
        });
    }

    private async promptForOllamaModel(providerConfig?: ProviderConfig): Promise<LLMModel> {
        const detected = providerConfig?.detectedModels ?? [];
        const choices: Array<{ name: string; value: string }> = [];

        // Show locally available models first (detected from Ollama)
        if (detected.length > 0) {
            for (const name of detected) {
                choices.push({ name: `${name} (installed)`, value: name });
            }
        }

        // Add preset models that aren't already detected
        const presets = PROVIDER_MODELS[AIProvider.OLLAMA];
        for (const m of presets) {
            if (m === LLMModel.OLLAMA_CUSTOM) continue;
            if (detected.some((d) => d.startsWith(m))) continue; // skip if detected variant exists
            choices.push({ name: MODEL_DISPLAY_NAMES[m], value: m });
        }

        const selected = await select({
            message: "Select your default model:",
            choices,
        });

        // If they picked a detected model that's not a preset, store it as custom
        const isPreset = Object.values(LLMModel).includes(selected as LLMModel);
        if (!isPreset) {
            // Update provider config with the custom model name
            if (providerConfig) {
                providerConfig.customModel = selected;
            }
            return LLMModel.OLLAMA_CUSTOM;
        }

        return selected as LLMModel;
    }

    private async promptForApiKey(provider: AIProvider, existingKey?: string): Promise<string> {
        const envVar = PROVIDER_ENV_VARS[provider];
        const envValue = process.env[envVar];

        if (envValue) {
            const useEnv = await confirm({
                message: `Found ${envVar} in environment. Use it?`,
                default: true,
            });
            if (useEnv) return envValue;
        }

        const masked = existingKey ? `${existingKey.slice(0, 8)}...${existingKey.slice(-4)}` : undefined;
        const hint = masked ? ` (current: ${masked})` : "";

        const key = await password({
            message: `${PROVIDER_DISPLAY_NAMES[provider]} API key${hint}:`,
            mask: "*",
        });

        if (!key && existingKey) return existingKey;
        if (!key) throw new Error(`API key is required for ${PROVIDER_DISPLAY_NAMES[provider]}`);
        return key;
    }

    private async configureSCMPlatforms(
        existing: PersonalConfiguration,
    ): Promise<Pick<PersonalConfiguration, "githubToken" | "bitbucketToken" | "bitbucketUsername" | "gitlabToken" | "gitlabInstanceUrl">> {
        logger.info("\n--- Source Control Platforms ---");

        const platforms = await checkbox({
            message: "Which source control platforms do you use?",
            choices: [
                { name: "GitHub", value: "github" as const, checked: !!existing.githubToken || this.checkGhCli() },
                { name: "Bitbucket", value: "bitbucket" as const, checked: !!existing.bitbucketToken },
                { name: "GitLab", value: "gitlab" as const, checked: !!existing.gitlabToken },
            ],
        });

        let githubToken = existing.githubToken;
        let bitbucketToken = existing.bitbucketToken;
        let bitbucketUsername = existing.bitbucketUsername;
        let gitlabToken = existing.gitlabToken;
        let gitlabInstanceUrl = existing.gitlabInstanceUrl;

        // GitHub
        if (platforms.includes("github")) {
            const hasGhCli = this.checkGhCli();
            if (hasGhCli) {
                logger.info("GitHub CLI detected — will use 'gh auth token' for GitHub access.");
                const overrideAnyway = await confirm({
                    message: "Store a separate token in config anyway?",
                    default: false,
                });
                if (overrideAnyway) {
                    githubToken = await password({ message: "GitHub personal access token:", mask: "*" });
                }
            } else if (process.env.GITHUB_TOKEN) {
                logger.info("Found GITHUB_TOKEN in environment.");
                const save = await confirm({ message: "Save it to config?", default: false });
                if (save) githubToken = process.env.GITHUB_TOKEN;
            } else {
                githubToken = await password({
                    message: `GitHub personal access token${existing.githubToken ? " (press enter to keep existing)" : ""}:`,
                    mask: "*",
                });
                if (!githubToken && existing.githubToken) githubToken = existing.githubToken;
            }
        }

        // Bitbucket
        if (platforms.includes("bitbucket")) {
            logger.info("\nBitbucket supports two auth methods:");
            const authMethod = await select({
                message: "How do you want to authenticate with Bitbucket?",
                choices: [
                    { name: "App password (username + app password)", value: "app_password" as const },
                    { name: "Repository/OAuth access token", value: "token" as const },
                ],
            });

            if (authMethod === "app_password") {
                bitbucketUsername = await input({
                    message: "Bitbucket username:",
                    default: existing.bitbucketUsername ?? process.env.BITBUCKET_USERNAME ?? "",
                });

                const existingAppPw = existing.bitbucketToken;
                if (process.env.BITBUCKET_APP_PASSWORD) {
                    logger.info("Found BITBUCKET_APP_PASSWORD in environment.");
                    const save = await confirm({ message: "Save it to config?", default: true });
                    if (save) bitbucketToken = process.env.BITBUCKET_APP_PASSWORD;
                } else {
                    bitbucketToken = await password({
                        message: `Bitbucket app password${existingAppPw ? " (press enter to keep existing)" : ""}:`,
                        mask: "*",
                    });
                    if (!bitbucketToken && existingAppPw) bitbucketToken = existingAppPw;
                }
            } else {
                if (process.env.BITBUCKET_TOKEN) {
                    logger.info("Found BITBUCKET_TOKEN in environment.");
                    const save = await confirm({ message: "Save it to config?", default: true });
                    if (save) bitbucketToken = process.env.BITBUCKET_TOKEN;
                } else {
                    const existingToken = existing.bitbucketToken;
                    bitbucketToken = await password({
                        message: `Bitbucket access token${existingToken ? " (press enter to keep existing)" : ""}:`,
                        mask: "*",
                    });
                    if (!bitbucketToken && existingToken) bitbucketToken = existingToken;
                }
                bitbucketUsername = undefined;
            }
        }

        // GitLab
        if (platforms.includes("gitlab")) {
            const envToken = process.env.GITLAB_TOKEN;
            if (envToken) {
                logger.info("Found GITLAB_TOKEN in environment.");
                const save = await confirm({ message: "Save it to config?", default: false });
                if (save) gitlabToken = envToken;
            } else {
                gitlabToken = await password({
                    message: `GitLab personal access token${existing.gitlabToken ? " (press enter to keep existing)" : ""}:`,
                    mask: "*",
                });
                if (!gitlabToken && existing.gitlabToken) gitlabToken = existing.gitlabToken;
            }

            const instanceUrl = await input({
                message: "GitLab instance URL (leave empty for gitlab.com):",
                default: existing.gitlabInstanceUrl ?? "",
            });
            gitlabInstanceUrl = instanceUrl.trim() || undefined;
        }

        return {
            githubToken: githubToken || undefined,
            bitbucketToken: bitbucketToken || undefined,
            bitbucketUsername: bitbucketUsername || undefined,
            gitlabToken: gitlabToken || undefined,
            gitlabInstanceUrl: gitlabInstanceUrl || undefined,
        };
    }

    private checkGhCli(): boolean {
        try {
            const { execSync } = require("child_process");
            execSync("gh auth status", { stdio: "pipe" });
            return true;
        } catch {
            return false;
        }
    }

    private printCurrentConfig(config: PersonalConfiguration): void {
        const providers = Object.entries(config.providers ?? {});
        if (providers.length > 0) {
            logger.info("  Providers:");
            for (const [key, val] of providers) {
                const provider = key as AIProvider;
                const isDefault = key === config.defaultProvider ? " (default)" : "";

                if (provider === AIProvider.BEDROCK) {
                    const profile = val.awsProfile ?? "default chain";
                    const region = val.awsRegion ?? "us-east-1";
                    logger.info(`    ${PROVIDER_DISPLAY_NAMES[provider]}: profile=${profile}, region=${region}${isDefault}`);
                } else if (provider === AIProvider.OLLAMA) {
                    const url = val.baseUrl ?? "http://localhost:11434";
                    const custom = val.customModel ? `, custom=${val.customModel}` : "";
                    logger.info(`    ${PROVIDER_DISPLAY_NAMES[provider]}: ${url}${custom}${isDefault}`);
                } else {
                    const masked = val.apiKey ? `${val.apiKey.slice(0, 8)}...${val.apiKey.slice(-4)}` : "not set";
                    logger.info(`    ${PROVIDER_DISPLAY_NAMES[provider]}: ${masked}${isDefault}`);
                }
            }
        }
        if (config.defaultModel) {
            logger.info(`  Default model: ${MODEL_DISPLAY_NAMES[config.defaultModel]}`);
        }
        // SCM platforms
        const scmPlatforms: string[] = [];
        if (config.githubToken) {
            scmPlatforms.push(`GitHub (token: ${config.githubToken.slice(0, 8)}...)`);
        } else if (this.checkGhCli()) {
            scmPlatforms.push("GitHub (via gh CLI)");
        }
        if (config.bitbucketToken) {
            const authType = config.bitbucketUsername ? `app password, user: ${config.bitbucketUsername}` : "access token";
            scmPlatforms.push(`Bitbucket (${authType})`);
        }
        if (config.gitlabToken) {
            const instance = config.gitlabInstanceUrl ?? "gitlab.com";
            scmPlatforms.push(`GitLab (token: ${config.gitlabToken.slice(0, 8)}..., instance: ${instance})`);
        }
        if (scmPlatforms.length > 0) {
            logger.info("  SCM platforms:");
            for (const p of scmPlatforms) {
                logger.info(`    ${p}`);
            }
        }
    }
}
