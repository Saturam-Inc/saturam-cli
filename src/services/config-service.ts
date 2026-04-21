import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { LLMModel } from "../constants/llm-models";
import { WorkingDirectory } from "../utils/working-directory";

// --- Schemas ---

export enum AIProvider {
    ANTHROPIC = "anthropic",
    BEDROCK = "bedrock",
    OPENAI = "openai",
    GOOGLE = "google",
    XAI = "xai",
    DEEPSEEK = "deepseek",
    OLLAMA = "ollama",
}

export const ProviderConfigSchema = z.object({
    apiKey: z.string().optional().describe("API key for this provider"),
    enabled: z.boolean().default(true).describe("Whether this provider is enabled"),
    // Bedrock-specific
    awsProfile: z.string().optional().describe("AWS CLI profile name (for Bedrock)"),
    awsRegion: z.string().optional().describe("AWS region (for Bedrock)"),
    // Ollama-specific
    baseUrl: z.string().optional().describe("Base URL for local model server (for Ollama)"),
    customModel: z.string().optional().describe("Custom model name (for Ollama custom models)"),
    detectedModels: z.array(z.string()).optional().describe("Models detected from the local Ollama instance"),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PersonalConfigurationSchema = z.object({
    defaultProvider: z.nativeEnum(AIProvider).optional().describe("Default AI provider"),
    defaultModel: z.nativeEnum(LLMModel).optional().describe("Default model to use"),
    providers: z
        .record(z.nativeEnum(AIProvider), ProviderConfigSchema)
        .optional()
        .default({})
        .describe("Configured AI providers with API keys"),
    githubToken: z.string().optional().describe("GitHub personal access token"),
    bitbucketToken: z.string().optional().describe("Bitbucket access token or app password"),
    bitbucketUsername: z.string().optional().describe("Bitbucket username (for app password auth)"),
    gitlabToken: z.string().optional().describe("GitLab personal access token"),
    gitlabInstanceUrl: z.string().optional().describe("GitLab instance base URL (for self-hosted, e.g. https://gitlab.example.com)"),
});

export type PersonalConfiguration = z.infer<typeof PersonalConfigurationSchema>;

export const ProjectConfigurationSchema = z.object({
    defaultModel: z.nativeEnum(LLMModel).optional().describe("Default model for this project"),
    defaultProvider: z.nativeEnum(AIProvider).optional().describe("Default provider for this project"),
});

export type ProjectConfiguration = z.infer<typeof ProjectConfigurationSchema>;

export const SessionConfigurationSchema = z.object({
    debug: z.boolean().optional().default(false).describe("Enable debug logging"),
    model: z.nativeEnum(LLMModel).optional().describe("The AI model to use"),
    quiet: z.boolean().optional().default(false).describe("Suppress output"),
    ci: z.boolean().optional().default(false).describe("Run in CI mode (no interactive prompts)"),
});

export type SessionConfiguration = z.infer<typeof SessionConfigurationSchema>;

// --- Provider to model mapping ---

export const PROVIDER_MODELS: Record<AIProvider, LLMModel[]> = {
    [AIProvider.ANTHROPIC]: [LLMModel.ANTHROPIC_CLAUDE_4_SONNET, LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET, LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS],
    [AIProvider.BEDROCK]: [LLMModel.BEDROCK_CLAUDE_4_SONNET, LLMModel.BEDROCK_CLAUDE_4_5_SONNET, LLMModel.BEDROCK_CLAUDE_4_6_OPUS, LLMModel.BEDROCK_NOVA_PRO],
    [AIProvider.GOOGLE]: [LLMModel.GEMINI_2_5_PRO, LLMModel.GEMINI_2_5_FLASH, LLMModel.GEMINI_3_PRO, LLMModel.GEMINI_3_FLASH],
    [AIProvider.OPENAI]: [LLMModel.OPENAI_GPT_4O, LLMModel.OPENAI_GPT_5, LLMModel.OPENAI_O3_MINI],
    [AIProvider.XAI]: [LLMModel.GROK_2],
    [AIProvider.DEEPSEEK]: [LLMModel.DEEPSEEK_CHAT, LLMModel.DEEPSEEK_REASONER],
    [AIProvider.OLLAMA]: [
        LLMModel.OLLAMA_LLAMA3, LLMModel.OLLAMA_LLAMA3_1, LLMModel.OLLAMA_LLAMA3_2,
        LLMModel.OLLAMA_CODELLAMA, LLMModel.OLLAMA_MISTRAL, LLMModel.OLLAMA_MIXTRAL,
        LLMModel.OLLAMA_DEEPSEEK_CODER_V2, LLMModel.OLLAMA_QWEN2_5_CODER,
        LLMModel.OLLAMA_GEMMA2, LLMModel.OLLAMA_PHI3, LLMModel.OLLAMA_CUSTOM,
    ],
};

export const PROVIDER_ENV_VARS: Record<AIProvider, string> = {
    [AIProvider.ANTHROPIC]: "ANTHROPIC_API_KEY",
    [AIProvider.BEDROCK]: "AWS_PROFILE",
    [AIProvider.OPENAI]: "OPENAI_API_KEY",
    [AIProvider.GOOGLE]: "GOOGLE_API_KEY",
    [AIProvider.XAI]: "XAI_API_KEY",
    [AIProvider.DEEPSEEK]: "DEEPSEEK_API_KEY",
    [AIProvider.OLLAMA]: "OLLAMA_BASE_URL",
};

export const PROVIDER_DEFAULT_KEY_PATHS: Record<AIProvider, string[]> = {
    [AIProvider.ANTHROPIC]: [],
    [AIProvider.BEDROCK]: [],
    [AIProvider.OPENAI]: [],
    [AIProvider.GOOGLE]: [join(homedir(), ".config", "google", "api_key")],
    [AIProvider.XAI]: [],
    [AIProvider.DEEPSEEK]: [],
    [AIProvider.OLLAMA]: [],
};

/** Providers that don't need an API key */
export const KEYLESS_PROVIDERS = new Set([AIProvider.BEDROCK, AIProvider.OLLAMA]);

// --- Service ---

@Service()
export class ConfigService {
    private session: SessionConfiguration = SessionConfigurationSchema.parse({});
    private personalConfig: PersonalConfiguration | null = null;

    constructor(private readonly dir: WorkingDirectory) {}

    // --- Personal Config (user-level: ~/.config/sateng/config.json) ---

    public getPersonalConfigPath(): string {
        if (process.env.SATENG_CONFIG_DIR) {
            return join(process.env.SATENG_CONFIG_DIR, "config.json");
        }
        // Platform-appropriate config directory:
        //   Windows: %APPDATA%\sateng\config.json
        //   macOS:   ~/Library/Application Support/sateng/config.json
        //   Linux:   ~/.config/sateng/config.json
        const configDir =
            process.platform === "win32"
                ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "sateng")
                : process.platform === "darwin"
                  ? join(homedir(), "Library", "Application Support", "sateng")
                  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sateng");
        return join(configDir, "config.json");
    }

    public async loadPersonalConfig(): Promise<PersonalConfiguration> {
        if (this.personalConfig) return this.personalConfig;

        const configPath = this.getPersonalConfigPath();
        if (existsSync(configPath)) {
            const raw = await readFile(configPath, "utf8");
            this.personalConfig = PersonalConfigurationSchema.parse(JSON.parse(raw));
        } else {
            this.personalConfig = PersonalConfigurationSchema.parse({});
        }
        return this.personalConfig;
    }

    public async savePersonalConfig(config: PersonalConfiguration): Promise<void> {
        const configPath = this.getPersonalConfigPath();
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(config, null, 4), "utf8");
        this.personalConfig = config;
    }

    // --- Project Config (repo-level: .sateng) ---

    public getProjectConfigPath(): string {
        return join(this.dir.repoRoot, ".sateng");
    }

    public async loadProjectConfig(): Promise<ProjectConfiguration | null> {
        const configPath = this.getProjectConfigPath();
        if (!existsSync(configPath)) return null;
        const raw = await readFile(configPath, "utf8");
        return ProjectConfigurationSchema.parse(JSON.parse(raw));
    }

    public async saveProjectConfig(config: ProjectConfiguration): Promise<void> {
        const configPath = this.getProjectConfigPath();
        await writeFile(configPath, JSON.stringify(config, null, 4), "utf8");
    }

    // --- Session ---

    public getSessionConfiguration(): SessionConfiguration {
        return this.session;
    }

    public async setSessionConfiguration(session: SessionConfiguration): Promise<void> {
        this.session = session;
    }

    // --- Model Resolution (CLI flag > project config > personal config > default) ---

    public async getModel(): Promise<LLMModel> {
        if (this.session.model) return this.session.model;

        const projectConfig = await this.loadProjectConfig();
        if (projectConfig?.defaultModel) return projectConfig.defaultModel;

        const personalConfig = await this.loadPersonalConfig();
        if (personalConfig.defaultModel) return personalConfig.defaultModel;

        return LLMModel.ANTHROPIC_CLAUDE_4_SONNET;
    }

    // --- API Key Resolution (env var > personal config > default key path) ---

    public async getApiKey(provider: AIProvider): Promise<string> {
        // Keyless providers (Bedrock uses AWS credentials, Ollama is local)
        if (KEYLESS_PROVIDERS.has(provider)) {
            return "";
        }

        // 1. Environment variable
        const envVar = PROVIDER_ENV_VARS[provider];
        if (process.env[envVar]) {
            return process.env[envVar]!;
        }

        // 2. Personal config
        const config = await this.loadPersonalConfig();
        const providerConfig = config.providers?.[provider];
        if (providerConfig?.apiKey) {
            return providerConfig.apiKey;
        }

        // 3. Default key file paths
        for (const keyPath of PROVIDER_DEFAULT_KEY_PATHS[provider]) {
            if (existsSync(keyPath)) {
                const key = (await readFile(keyPath, "utf8")).trim();
                if (key) return key;
            }
        }

        throw new Error(
            `No API key found for ${provider}. Set ${envVar}, run 'sat-cli init', or add it to ${this.getPersonalConfigPath()}.`,
        );
    }

    public async getProviderConfig(provider: AIProvider): Promise<ProviderConfig | undefined> {
        const config = await this.loadPersonalConfig();
        return config.providers?.[provider];
    }

    // --- GitHub Token ---

    public async getGitHubToken(): Promise<string> {
        // 1. Env var
        if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

        // 2. Personal config
        const config = await this.loadPersonalConfig();
        if (config.githubToken) return config.githubToken;

        // 3. gh CLI
        const { execSync } = await import("child_process");
        try {
            return execSync("gh auth token", { encoding: "utf8" }).trim();
        } catch {
            throw new Error("No GitHub token found. Set GITHUB_TOKEN, run 'sat-cli init', or run 'gh auth login'.");
        }
    }

    // --- GitLab Token ---

    public async getGitLabToken(): Promise<string> {
        // 1. Env var
        if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;

        // 2. Personal config
        const config = await this.loadPersonalConfig();
        if (config.gitlabToken) return config.gitlabToken;

        throw new Error("No GitLab token found. Set GITLAB_TOKEN, run 'sat-cli init', or add it to your config.");
    }

    // --- GitLab Instance URL ---

    public async getGitLabInstanceUrl(): Promise<string | undefined> {
        if (process.env.GITLAB_INSTANCE_URL) return process.env.GITLAB_INSTANCE_URL;
        const config = await this.loadPersonalConfig();
        return config.gitlabInstanceUrl;
    }

    // --- Static helpers ---

    public static async getConfigurationRoot(cwd: string): Promise<string | null> {
        if (existsSync(join(cwd, ".sateng"))) return cwd;
        return null;
    }
}
