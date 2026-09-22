import { existsSync, statSync } from "fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { getLogger } from "log4js";
import { LLMModel } from "../constants/llm-models";
import { WorkingDirectory } from "../utils/working-directory";

const logger = getLogger("ConfigService");

// --- Schemas ---

export enum AIProvider {
    ANTHROPIC = "anthropic",
    BEDROCK = "bedrock",
    OPENAI = "openai",
    AZURE_OPENAI = "azure-openai",
    GOOGLE = "google",
    XAI = "xai",
    DEEPSEEK = "deepseek",
    OLLAMA = "ollama",
    SELF_HOSTED = "self-hosted",
}

export const ProviderConfigSchema = z.object({
    apiKey: z.string().optional().describe("API key for this provider"),
    enabled: z.boolean().default(true).describe("Whether this provider is enabled"),
    // Bedrock-specific
    awsProfile: z.string().optional().describe("AWS CLI profile name (for Bedrock)"),
    awsRegion: z.string().optional().describe("AWS region (for Bedrock)"),
    // OpenAI-specific
    baseUrl: z.string().optional().describe("Base URL for OpenAI API (for custom OpenAI-compatible endpoints)"),
    // Azure OpenAI-specific
    azureEndpoint: z
        .string()
        .optional()
        .describe("Azure OpenAI resource endpoint, e.g. https://my-res.openai.azure.com"),
    azureDeploymentName: z.string().optional().describe("Azure OpenAI deployment name (acts as the model ID)"),
    azureApiVersion: z.string().optional().describe("Azure OpenAI REST API version, e.g. 2024-10-21"),
    // Ollama-specific
    ollamaBaseUrl: z.string().optional().describe("Base URL for local model server (for Ollama)"),
    apiToken: z.string().optional().describe("Bearer token for remote Ollama API gateways"),
    model: z.string().optional().describe("Model name for Ollama API-compatible servers / self-hosted models"),
    detectedModels: z.array(z.string()).optional().describe("Models detected from the local Ollama instance"),
    // Self-hosted-specific
    endpoint: z.string().optional().describe("Self-hosted model endpoint URL"),
    accessToken: z.string().optional().describe("Optional bearer token for self-hosted model server"),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// --- Cloud provider config (storage & retrieval, distinct from AI chat providers) ---

export enum CloudProvider {
    AWS = "aws",
    AZURE = "azure",
    GCP = "gcp",
}

export const CloudProviderConfigSchema = z.object({
    enabled: z.boolean().default(true).describe("Whether this cloud provider is enabled"),
    // AWS auth — field names intentionally match ProviderConfigSchema's awsProfile/awsRegion
    awsAuthMethod: z.enum(["profile", "keys"]).optional().describe("AWS auth method: CLI profile or access keys"),
    awsProfile: z.string().optional().describe("AWS CLI profile name"),
    awsRegion: z.string().optional().describe("AWS region"),
    awsAccessKeyId: z.string().optional().describe("AWS access key ID"),
    awsSecretAccessKey: z.string().optional().describe("AWS secret access key"),
    awsSessionToken: z.string().optional().describe("Optional AWS session token (temporary credentials)"),
    s3: z
        .object({
            bucket: z.string().describe("S3 bucket name"),
            prefix: z.string().optional().describe("Key prefix within the bucket"),
            statePrefix: z
                .string()
                .optional()
                .describe(
                    'Key prefix holding ingestion state (registry.json, run status). Defaults to "<prefix>-state", ' +
                        "which keeps state files out of the content prefix so Bedrock never ingests them as documents.",
                ),
            region: z.string().optional().describe("Bucket region (defaults to awsRegion)"),
        })
        .optional()
        .describe("S3 bucket access configuration"),
    bedrockKnowledgeBase: z
        .object({
            knowledgeBaseId: z.string().describe("Bedrock Knowledge Base ID"),
            dataSourceId: z.string().optional().describe("Bedrock Knowledge Base data source ID"),
            region: z.string().optional().describe("Knowledge base region (defaults to awsRegion)"),
        })
        .optional()
        .describe("Bedrock Knowledge Base retrieval configuration"),
    conversationTable: z
        .object({
            tableName: z.string().describe("DynamoDB table holding conversation history"),
            region: z.string().optional().describe("Table region (defaults to awsRegion)"),
            ttlDays: z.number().int().positive().optional().describe("Days before a session expires"),
        })
        .optional()
        .describe("DynamoDB conversation memory configuration"),
});

export type CloudProviderConfig = z.infer<typeof CloudProviderConfigSchema>;

const KNOWN_MODEL_IDS = new Set<string>(Object.values(LLMModel));

// A model ID saved by a previous CLI version can be retired by the provider (or renamed here)
// after the fact. Falling back to undefined (rather than letting the enum check throw) means one
// stale saved value degrades to "use the default model" instead of breaking config loading
// entirely — every ConfigService method that touches personal/project/session config depends on
// this parse succeeding.
const migrateModelId = (val: unknown) => {
    if (typeof val !== "string") return val;
    const withoutRegionPrefix = val.replace(/^(us|eu|ap)\./, "");
    if (!KNOWN_MODEL_IDS.has(withoutRegionPrefix)) {
        logger.warn(`Unrecognized saved model ID "${val}" — ignoring it and falling back to the default model.`);
        return undefined;
    }
    return withoutRegionPrefix;
};
const modelField = z.preprocess(migrateModelId, z.nativeEnum(LLMModel).optional());

export const PersonalConfigurationSchema = z.object({
    defaultProvider: z.nativeEnum(AIProvider).optional().describe("Default AI provider"),
    defaultModel: modelField.describe("Default model to use"),
    providers: z
        .record(z.nativeEnum(AIProvider), ProviderConfigSchema)
        .optional()
        .default({})
        .describe("Configured AI providers with API keys"),
    githubToken: z.string().optional().describe("GitHub personal access token"),
    bitbucketToken: z.string().optional().describe("Bitbucket API token"),
    bitbucketEmail: z.string().optional().describe("Atlassian account email (required with API token)"),
    bitbucketUsername: z.string().optional().describe("Bitbucket username (legacy app password auth only)"),
    gitlabToken: z.string().optional().describe("GitLab personal access token"),
    gitlabInstanceUrl: z
        .string()
        .optional()
        .describe("GitLab instance base URL (for self-hosted, e.g. https://gitlab.example.com)"),
    atlassianEmail: z.string().optional().describe("Atlassian account email (Jira & Confluence)"),
    atlassianToken: z.string().optional().describe("Atlassian API token (Jira & Confluence)"),
    googleAccessToken: z.string().optional().describe("Google OAuth access token (Drive / Docs / Sheets)"),
    cloud: z
        .record(z.nativeEnum(CloudProvider), CloudProviderConfigSchema)
        .optional()
        .describe("Configured cloud providers (AWS/Azure/GCP) for storage & retrieval"),
    defaultCloudProvider: z.nativeEnum(CloudProvider).optional().describe("Default cloud provider"),
});

export type PersonalConfiguration = z.infer<typeof PersonalConfigurationSchema>;

export const ProjectConfigurationSchema = z.object({
    defaultModel: modelField.describe("Default model for this project"),
    defaultProvider: z.nativeEnum(AIProvider).optional().describe("Default provider for this project"),
});

export type ProjectConfiguration = z.infer<typeof ProjectConfigurationSchema>;

export const SessionConfigurationSchema = z.object({
    debug: z.boolean().optional().default(false).describe("Enable debug logging"),
    model: modelField.describe("The AI model to use"),
    quiet: z.boolean().optional().default(false).describe("Suppress output"),
    ci: z.boolean().optional().default(false).describe("Run in CI mode (no interactive prompts)"),
});

export type SessionConfiguration = z.infer<typeof SessionConfigurationSchema>;

// --- Provider to model mapping ---

export const PROVIDER_MODELS: Record<AIProvider, LLMModel[]> = {
    [AIProvider.ANTHROPIC]: [
        LLMModel.ANTHROPIC_CLAUDE_4_SONNET,
        LLMModel.ANTHROPIC_CLAUDE_4_5_SONNET,
        LLMModel.ANTHROPIC_CLAUDE_4_6_OPUS,
    ],
    [AIProvider.BEDROCK]: [
        LLMModel.BEDROCK_CLAUDE_4_SONNET,
        LLMModel.BEDROCK_CLAUDE_4_5_SONNET,
        LLMModel.BEDROCK_CLAUDE_4_6_OPUS,
        LLMModel.BEDROCK_NOVA_PRO,
    ],
    [AIProvider.GOOGLE]: [
        LLMModel.GEMINI_2_5_PRO,
        LLMModel.GEMINI_2_5_FLASH,
        LLMModel.GEMINI_3_1_PRO_PREVIEW,
        LLMModel.GEMINI_3_5_FLASH,
        LLMModel.GEMINI_3_6_FLASH,
        LLMModel.GEMINI_3_7_FLASH,
    ],
    [AIProvider.OPENAI]: [
        LLMModel.OPENAI_GPT_4O,
        LLMModel.OPENAI_GPT_5,
        LLMModel.OPENAI_O3_MINI,
        LLMModel.OPENAI_GPT_OSS_120B,
        LLMModel.OPENAI_GPT_OSS_20B,
        LLMModel.OPENAI_QWEN3_NEXT_80B_A3B_INSTRUCT,
        LLMModel.OPENAI_GEMMA_4_26B_A4B_IT,
        LLMModel.OPENAI_GEMMA_4_31B_IT,
        LLMModel.OPENAI_LLAMA_3_3_70B_INSTRUCT,
    ],
    [AIProvider.AZURE_OPENAI]: [LLMModel.AZURE_OPENAI_CUSTOM],
    [AIProvider.XAI]: [LLMModel.GROK_2],
    [AIProvider.DEEPSEEK]: [LLMModel.DEEPSEEK_CHAT, LLMModel.DEEPSEEK_REASONER],
    [AIProvider.OLLAMA]: [
        LLMModel.OLLAMA_LLAMA3,
        LLMModel.OLLAMA_LLAMA3_1,
        LLMModel.OLLAMA_LLAMA3_2,
        LLMModel.OLLAMA_CODELLAMA,
        LLMModel.OLLAMA_MISTRAL,
        LLMModel.OLLAMA_MIXTRAL,
        LLMModel.OLLAMA_DEEPSEEK_CODER_V2,
        LLMModel.OLLAMA_QWEN2_5_CODER,
        LLMModel.OLLAMA_GEMMA2,
        LLMModel.OLLAMA_PHI3,
        LLMModel.OLLAMA_CUSTOM,
    ],
    [AIProvider.SELF_HOSTED]: [LLMModel.SELF_HOSTED_CUSTOM],
};

export const PROVIDER_ENV_VARS: Record<AIProvider, string> = {
    [AIProvider.ANTHROPIC]: "ANTHROPIC_API_KEY",
    [AIProvider.BEDROCK]: "AWS_PROFILE",
    [AIProvider.OPENAI]: "OPENAI_API_KEY",
    [AIProvider.AZURE_OPENAI]: "AZURE_OPENAI_API_KEY",
    [AIProvider.GOOGLE]: "GOOGLE_API_KEY",
    [AIProvider.XAI]: "XAI_API_KEY",
    [AIProvider.DEEPSEEK]: "DEEPSEEK_API_KEY",
    [AIProvider.OLLAMA]: "OLLAMA_BASE_URL",
    [AIProvider.SELF_HOSTED]: "SELF_HOSTED_ACCESS_TOKEN",
};

export const PROVIDER_BASE_URL_ENV_VARS: Record<AIProvider, string | undefined> = {
    [AIProvider.ANTHROPIC]: undefined,
    [AIProvider.BEDROCK]: undefined,
    [AIProvider.OPENAI]: "OPENAI_BASE_URL",
    [AIProvider.AZURE_OPENAI]: "AZURE_OPENAI_ENDPOINT",
    [AIProvider.GOOGLE]: undefined,
    [AIProvider.XAI]: undefined,
    [AIProvider.DEEPSEEK]: undefined,
    [AIProvider.OLLAMA]: "OLLAMA_BASE_URL",
    [AIProvider.SELF_HOSTED]: "SELF_HOSTED_ENDPOINT",
};

export const PROVIDER_DEFAULT_KEY_PATHS: Record<AIProvider, string[]> = {
    [AIProvider.ANTHROPIC]: [],
    [AIProvider.BEDROCK]: [],
    [AIProvider.OPENAI]: [],
    [AIProvider.AZURE_OPENAI]: [],
    [AIProvider.GOOGLE]: [join(homedir(), ".config", "google", "api_key")],
    [AIProvider.XAI]: [],
    [AIProvider.DEEPSEEK]: [],
    [AIProvider.OLLAMA]: [],
    [AIProvider.SELF_HOSTED]: [],
};

/** Providers that don't need a mandatory API key */
export const KEYLESS_PROVIDERS = new Set([AIProvider.BEDROCK, AIProvider.OLLAMA, AIProvider.SELF_HOSTED]);

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
            this.personalConfig = PersonalConfigurationSchema.parse(this.normalizePersonalConfig(JSON.parse(raw)));
        } else {
            this.personalConfig = PersonalConfigurationSchema.parse({});
        }
        return this.personalConfig;
    }

    private normalizePersonalConfig(raw: unknown): unknown {
        if (!raw || typeof raw !== "object") return raw;

        const config = raw as Record<string, unknown>;
        const providers = this.normalizeProviders(config.providers);

        if (config.defaultProvider === "selfhosted") {
            config.defaultProvider = AIProvider.SELF_HOSTED;
        }
        if (config.defaultModel === "selfhosted-custom" || config.defaultModel === "self-hosted-custom") {
            config.defaultModel = LLMModel.SELF_HOSTED_CUSTOM;
        }

        if (config.provider === AIProvider.SELF_HOSTED || config.provider === "selfhosted") {
            const selfHosted = config.selfHosted as Record<string, unknown> | undefined;
            const providerConfig: ProviderConfig = { enabled: true };
            const endpoint = selfHosted?.endpoint ?? selfHosted?.selfHostedEndpoint;
            const model = selfHosted?.model ?? selfHosted?.customModel;
            if (typeof endpoint === "string") providerConfig.endpoint = endpoint;
            if (typeof model === "string") providerConfig.model = model;
            if (typeof selfHosted?.accessToken === "string") providerConfig.accessToken = selfHosted.accessToken;

            return {
                ...config,
                defaultProvider: AIProvider.SELF_HOSTED,
                defaultModel: LLMModel.SELF_HOSTED_CUSTOM,
                providers: {
                    ...providers,
                    [AIProvider.SELF_HOSTED]: {
                        ...(providers?.[AIProvider.SELF_HOSTED] ?? {}),
                        ...providerConfig,
                    },
                },
            };
        }

        if (config.provider !== AIProvider.OLLAMA) {
            return providers === config.providers ? raw : { ...config, providers };
        }

        const providerConfig: ProviderConfig = { enabled: true };
        if (typeof config.baseUrl === "string") providerConfig.baseUrl = config.baseUrl;
        if (typeof config.apiToken === "string") providerConfig.apiToken = config.apiToken;
        if (typeof config.model === "string") providerConfig.model = config.model;

        return {
            ...config,
            defaultProvider: AIProvider.OLLAMA,
            defaultModel: LLMModel.OLLAMA_CUSTOM,
            providers: {
                ...(providers ?? {}),
                [AIProvider.OLLAMA]: {
                    ...(providers?.[AIProvider.OLLAMA] ?? {}),
                    ...providerConfig,
                },
            },
        };
    }

    private normalizeProviders(rawProviders: unknown): PersonalConfiguration["providers"] | undefined {
        if (!rawProviders || typeof rawProviders !== "object") return rawProviders as undefined;

        const rawProvidersObj = rawProviders as Record<string, any>;
        const providers: Record<string, any> = {};

        for (const [key, rawConfig] of Object.entries(rawProvidersObj)) {
            if (rawConfig && typeof rawConfig === "object") {
                const config = { ...rawConfig };

                // Normalize selfHostedEndpoint to endpoint
                if (config.selfHostedEndpoint) {
                    if (!config.endpoint) {
                        config.endpoint = config.selfHostedEndpoint;
                    }
                    delete config.selfHostedEndpoint;
                }
                // Normalize customModel to model
                if (config.customModel) {
                    if (!config.model) {
                        config.model = config.customModel;
                    }
                    delete config.customModel;
                }

                providers[key] = config;
            } else {
                providers[key] = rawConfig;
            }
        }

        if (providers.selfhosted) {
            providers[AIProvider.SELF_HOSTED] = {
                ...providers.selfhosted,
                ...providers[AIProvider.SELF_HOSTED],
            };
            delete providers.selfhosted;
        }

        // Apply same normalization for selfhosted after merge if needed
        const shConfig = providers[AIProvider.SELF_HOSTED];
        if (shConfig && typeof shConfig === "object") {
            if (shConfig.selfHostedEndpoint) {
                if (!shConfig.endpoint) {
                    shConfig.endpoint = shConfig.selfHostedEndpoint;
                }
                delete shConfig.selfHostedEndpoint;
            }
            if (shConfig.customModel) {
                if (!shConfig.model) {
                    shConfig.model = shConfig.customModel;
                }
                delete shConfig.customModel;
            }
        }

        return providers as PersonalConfiguration["providers"];
    }

    public async savePersonalConfig(config: PersonalConfiguration): Promise<void> {
        const configPath = this.getPersonalConfigPath();
        await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
        await writeFile(configPath, JSON.stringify(config, null, 4), { encoding: "utf8", mode: 0o600 });
        await chmod(configPath, 0o600);
        this.personalConfig = config;
    }

    // --- Project Config (repo-level: .sateng/) ---

    /** The single source of truth for the repo-level ".sateng" directory. */
    public getProjectConfigDir(): string {
        return join(this.dir.repoRoot, ".sateng");
    }

    public getProjectConfigPath(): string {
        return join(this.getProjectConfigDir(), "config.json");
    }

    public async loadProjectConfig(): Promise<ProjectConfiguration | null> {
        const configPath = this.getProjectConfigPath();
        if (existsSync(configPath)) {
            try {
                if (statSync(configPath).isDirectory()) return null;
            } catch {
                return null;
            }
            const raw = await readFile(configPath, "utf8");
            return ProjectConfigurationSchema.parse(JSON.parse(raw));
        }

        // Legacy layout: ".sateng" used to be the config file itself, before it became a
        // directory (see getProjectConfigDir). Keep reading it until it's migrated on next save.
        const legacyPath = this.getProjectConfigDir();
        if (existsSync(legacyPath) && statSync(legacyPath).isFile()) {
            const raw = await readFile(legacyPath, "utf8");
            return ProjectConfigurationSchema.parse(JSON.parse(raw));
        }

        return null;
    }

    public async saveProjectConfig(config: ProjectConfiguration): Promise<void> {
        const configDir = this.getProjectConfigDir();

        // Migrate: an existing ".sateng" *file* (legacy layout) blocks creating ".sateng" as a
        // directory — remove it now that its content is being folded into the new location.
        if (existsSync(configDir) && statSync(configDir).isFile()) {
            await unlink(configDir);
        }

        await mkdir(configDir, { recursive: true });
        await writeFile(this.getProjectConfigPath(), JSON.stringify(config, null, 4), "utf8");
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

    /**
     * Whether at least one AI/LLM provider is usable — either configured via 'sat-cli init'
     * or available purely from its environment variable (the same sources getApiKey() honours,
     * so e.g. `sat-cli review` working with just ANTHROPIC_API_KEY set doesn't get rejected here).
     */
    public async hasAnyLLMProviderConfigured(): Promise<boolean> {
        const config = await this.loadPersonalConfig();
        if (Object.keys(config.providers ?? {}).length > 0) return true;
        return Object.values(PROVIDER_ENV_VARS).some((envVar) => Boolean(process.env[envVar]));
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

    // --- Google Token Management ---

    public async getGoogleAccessToken(): Promise<string> {
        if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;

        const personalConfig = await this.loadPersonalConfig();
        if (personalConfig.googleAccessToken) {
            return personalConfig.googleAccessToken;
        }

        throw new Error(
            "No Google Access Token found. Set GOOGLE_ACCESS_TOKEN, or run 'sat-cli init' and select 'Google (Drive / Docs / Sheets)' to configure credentials.",
        );
    }

    // --- Cloud Provider Config (AWS/Azure/GCP: storage & retrieval) ---

    public async getCloudConfig(provider: CloudProvider): Promise<CloudProviderConfig | undefined> {
        const config = await this.loadPersonalConfig();
        return config.cloud?.[provider];
    }

    public async getAWSCloudConfig(): Promise<CloudProviderConfig> {
        const cloudConfig = await this.getCloudConfig(CloudProvider.AWS);
        if (!cloudConfig) {
            throw new Error("AWS cloud is not configured. Run 'sat-cli init' and select 'Cloud (AWS / Azure / GCP)'.");
        }
        return cloudConfig;
    }

    /**
     * The bucket plus both prefixes the CLI reads and writes under.
     *
     * `prefix` holds the synced documents, which the Bedrock data source ingests. `statePrefix`
     * holds what the ingestion pipeline writes about that corpus — registry.json and run status —
     * and is deliberately a sibling of the content prefix rather than a folder inside it, so a
     * state file is never picked up and indexed as if it were documentation.
     */
    public async getS3Config(): Promise<{ bucket: string; prefix?: string; statePrefix?: string; region: string }> {
        const cloudConfig = await this.getAWSCloudConfig();
        if (!cloudConfig.s3) {
            throw new Error(
                "S3 is not configured. Run 'sat-cli init' → 'Cloud (AWS / Azure / GCP)' → AWS and configure S3 bucket access.",
            );
        }
        const region = cloudConfig.s3.region ?? cloudConfig.awsRegion;
        if (!region) {
            throw new Error(
                "S3 region is not configured. Run 'sat-cli init' → 'Cloud (AWS / Azure / GCP)' → AWS and set an AWS region or bucket region.",
            );
        }
        return {
            bucket: cloudConfig.s3.bucket,
            prefix: cloudConfig.s3.prefix,
            statePrefix: ConfigService.resolveStatePrefix(cloudConfig.s3.prefix, cloudConfig.s3.statePrefix),
            region,
        };
    }

    /**
     * Where ingestion state lives, given the content prefix. An explicit setting always wins.
     * Otherwise it is the content prefix with a "-state" suffix; with no content prefix at all
     * there is nothing to sit beside, so state stays at the bucket root — which is also what the
     * CLI did before this setting existed, so an existing config keeps resolving the same key.
     */
    public static resolveStatePrefix(prefix?: string, statePrefix?: string): string | undefined {
        if (statePrefix?.trim()) return statePrefix.trim().replace(/\/+$/, "");
        const trimmed = prefix?.trim().replace(/\/+$/, "");
        return trimmed ? `${trimmed}-state` : undefined;
    }

    public async getBedrockKnowledgeBaseConfig(): Promise<{
        knowledgeBaseId: string;
        dataSourceId?: string;
        region: string;
    }> {
        const cloudConfig = await this.getAWSCloudConfig();
        if (!cloudConfig.bedrockKnowledgeBase) {
            throw new Error(
                "Bedrock Knowledge Base is not configured. Run 'sat-cli init' → 'Cloud (AWS / Azure / GCP)' → AWS and configure Bedrock Knowledge Base retrieval.",
            );
        }
        const region = cloudConfig.bedrockKnowledgeBase.region ?? cloudConfig.awsRegion;
        if (!region) {
            throw new Error(
                "Bedrock Knowledge Base region is not configured. Run 'sat-cli init' → 'Cloud (AWS / Azure / GCP)' → AWS and set an AWS region or knowledge base region.",
            );
        }
        return {
            knowledgeBaseId: cloudConfig.bedrockKnowledgeBase.knowledgeBaseId,
            dataSourceId: cloudConfig.bedrockKnowledgeBase.dataSourceId,
            region,
        };
    }

    /**
     * Conversation memory table, or undefined when none is configured — the caller then falls
     * back to the in-memory store rather than failing, so the chat flow works without AWS access.
     */
    public async getConversationTableConfig(): Promise<
        { tableName: string; region: string; ttlDays: number } | undefined
    > {
        const cloudConfig = await this.getCloudConfig(CloudProvider.AWS);
        const table = cloudConfig?.conversationTable;
        if (!table) return undefined;

        const region = table.region ?? cloudConfig?.awsRegion;
        if (!region) {
            logger.warn(
                "A conversation table is configured but no region was resolved — falling back to in-memory conversation history.",
            );
            return undefined;
        }
        return { tableName: table.tableName, region, ttlDays: table.ttlDays ?? 90 };
    }

    // --- Atlassian Credentials Helper ---

    public async getAtlassianCredentials(): Promise<{ email?: string; token: string }> {
        return this.getGenericAtlassianCredentials();
    }

    public async getGenericAtlassianCredentials(): Promise<{ email?: string; token: string }> {
        if (process.env.ATLASSIAN_TOKEN) {
            return {
                email: process.env.ATLASSIAN_EMAIL,
                token: process.env.ATLASSIAN_TOKEN,
            };
        }

        const personalConfig = await this.loadPersonalConfig();
        if (personalConfig.atlassianToken) {
            return {
                email: personalConfig.atlassianEmail,
                token: personalConfig.atlassianToken,
            };
        }

        throw new Error(
            "No Atlassian credentials found. Set ATLASSIAN_TOKEN (and optionally ATLASSIAN_EMAIL) env vars, or run 'sat-cli init' and select 'Atlassian (Jira & Confluence)'.",
        );
    }

    public async getConfluenceCredentials(): Promise<{ email?: string; token: string }> {
        if (process.env.CONFLUENCE_TOKEN) {
            return {
                email: process.env.CONFLUENCE_EMAIL,
                token: process.env.CONFLUENCE_TOKEN,
            };
        }
        return this.getGenericAtlassianCredentials();
    }

    public async getJiraCredentials(): Promise<{ email?: string; token: string }> {
        if (process.env.JIRA_TOKEN) {
            return {
                email: process.env.JIRA_EMAIL,
                token: process.env.JIRA_TOKEN,
            };
        }
        return this.getGenericAtlassianCredentials();
    }

    // --- Static helpers ---

    public static async getConfigurationRoot(cwd: string): Promise<string | null> {
        if (existsSync(join(cwd, ".sateng"))) return cwd;
        return null;
    }
}
