import type { BaseMessage, UsageMetadata } from "@langchain/core/messages";
import { getLogger } from "log4js";
import { Service } from "typedi";
import { ChatModel, LLMModel, LLMOptions, getModelProvider, isBedrockModel } from "../constants/llm-models";
import { AIProvider, ConfigService, ProviderConfig } from "./config-service";
import { RemoteCredentialService, type AwsCredentials } from "./remote-credential.service";
import type { TokenUsageTracker } from "./token-usage-tracker";

import { normalizeBaseUrl } from "../utils/url-utils";

const logger = getLogger("LlmService");

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_SELF_HOSTED_TIMEOUT_MS = 120000;
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21";

/**
 * Retries LangChain makes per Azure call. Its default is 6 with exponential backoff, which for one
 * throttled or unparseable response means about 90 seconds of waiting — longer than the Slack
 * bot's answering budget, and the bot has its own retry above this. Two still rides out a blip.
 */
const AZURE_MAX_RETRIES = 2;

type OllamaChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

function getMessageContent(message: BaseMessage): string {
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function toOllamaChatMessages(messages: BaseMessage[]): OllamaChatMessage[] {
    return messages.map((message) => {
        const type = message._getType();
        const role = type === "system" ? "system" : type === "ai" ? "assistant" : "user";
        return { role, content: getMessageContent(message) };
    });
}

function getSelfHostedAuthToken(providerConfig?: ProviderConfig): string | undefined {
    return (
        providerConfig?.accessToken ??
        providerConfig?.apiToken ??
        providerConfig?.apiKey ??
        process.env.SELF_HOSTED_ACCESS_TOKEN ??
        process.env.SELF_HOSTED_API_KEY
    );
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
        return `${error.message}${cause}`;
    }
    return String(error);
}

function parseOllamaChatResponse(text: string): {
    content: string;
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
} {
    const trimmed = text.trim();
    if (!trimmed) {
        throw new Error("Self-hosted LLM returned an empty response.");
    }

    let content = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim()) continue;

        let data: unknown;
        try {
            data = JSON.parse(line);
        } catch {
            throw new Error("Self-hosted LLM returned an invalid JSON response.");
        }

        const messageContent = (data as { message?: { content?: unknown } }).message?.content;
        if (typeof messageContent === "string") {
            content += messageContent;
        }

        const promptEvalCount = (data as { prompt_eval_count?: unknown }).prompt_eval_count;
        if (typeof promptEvalCount === "number") {
            inputTokens = promptEvalCount;
        }

        const evalCount = (data as { eval_count?: unknown }).eval_count;
        if (typeof evalCount === "number") {
            outputTokens = evalCount;
        }
    }

    if (!content) {
        throw new Error("Self-hosted LLM returned an invalid response: missing message.content.");
    }

    const usage_metadata =
        inputTokens !== undefined || outputTokens !== undefined
            ? { input_tokens: inputTokens, output_tokens: outputTokens }
            : undefined;

    return { content, usage_metadata };
}

/**
 * Anthropic models on Bedrock are invoked through a cross-region inference profile, whose id is
 * the model id behind a geography prefix. Asia Pacific's is "apac", not "ap" — an "ap." id does
 * not exist, so every ap-* region used to fail. SATENG_BEDROCK_PROFILE_PREFIX overrides the
 * choice, for the "global" profile or a narrower one such as "jp" or "au".
 */
export function bedrockInferenceProfilePrefix(
    region: string,
    override: string | undefined = process.env.SATENG_BEDROCK_PROFILE_PREFIX,
): string {
    if (override?.trim()) return override.trim();
    if (region.startsWith("eu")) return "eu";
    if (region.startsWith("ap")) return "apac";
    return "us";
}

/**
 * The Anthropic API base URL for an Azure AI Foundry resource.
 *
 * The portal shows the endpoint in several shapes — the bare resource URL, the ".../anthropic"
 * base, or the full ".../anthropic/v1/messages" target URI — and any of them may be pasted in.
 * All three resolve to "https://<resource>.services.ai.azure.com/anthropic", which the Anthropic
 * client extends with "/v1/messages" itself.
 */
export function azureFoundryAnthropicBaseUrl(endpoint: string): string {
    const base = normalizeBaseUrl(endpoint.trim())
        .replace(/\/v1\/messages$/, "")
        .replace(/\/v1$/, "");
    return base.endsWith("/anthropic") ? base : `${base}/anthropic`;
}

/**
 * Splits an Azure OpenAI endpoint as pasted from the portal into its parts.
 *
 * The portal's "Target URI" is the full request URL —
 * "https://<res>.cognitiveservices.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<v>"
 * — while the client wants only the resource URL and builds the rest itself. Accepting either means
 * the value can be copied as shown, and the API version the portal chose for the model (GPT-5-family
 * models need a recent one) comes along with it.
 */
export function parseAzureOpenAITarget(uri: string): {
    endpoint: string;
    deploymentName?: string;
    apiVersion?: string;
} {
    const trimmed = uri.trim();
    let apiVersion: string | undefined;
    let path = trimmed;
    try {
        const url = new URL(trimmed);
        apiVersion = url.searchParams.get("api-version") ?? undefined;
        path = `${url.origin}${url.pathname}`;
    } catch {
        // Not a URL the parser accepts; fall through with the raw value and let the client complain.
    }
    const deploymentName = /\/openai\/deployments\/([^/?#]+)/i.exec(path)?.[1];
    const endpoint = normalizeBaseUrl(normalizeBaseUrl(path).replace(/\/openai(\/.*)?$/i, ""));
    return {
        endpoint,
        deploymentName: deploymentName ? decodeURIComponent(deploymentName) : undefined,
        apiVersion: apiVersion || undefined,
    };
}

/**
 * Whether an Azure OpenAI deployment accepts a caller-chosen temperature.
 *
 * GPT-5-family and o-series models reject any temperature but their default ("Unsupported value:
 * 'temperature'"), and LangChain only recognises the o-series. The deployment name is all there is
 * to go on — Azure lets it be anything — so it is matched on the model-name prefix Azure proposes
 * by default, and AZURE_OPENAI_SUPPORTS_TEMPERATURE ("true"/"false") settles it for a deployment
 * named otherwise.
 */
export function azureOpenAIAcceptsTemperature(
    deploymentName: string,
    override: string | undefined = process.env.AZURE_OPENAI_SUPPORTS_TEMPERATURE,
): boolean {
    if (override?.trim()) return override.trim().toLowerCase() !== "false";
    return !/^(gpt-5|o\d)/i.test(deploymentName.trim());
}

@Service()
export class LlmService {
    private llms: Map<string, ChatModel> = new Map();
    private selfHostedQueue = Promise.resolve();

    constructor(
        private readonly config: ConfigService,
        private readonly remoteCredentials: RemoteCredentialService,
    ) {}

    public async getModel(model?: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const selectedModel = model ?? (await this.config.getModel());
        const isRemoteBedrock = isBedrockModel(selectedModel) && !!(await this.config.getRemoteConfig());

        const key = `${selectedModel}:${JSON.stringify(options ?? {})}`;

        if (!isRemoteBedrock && this.llms.has(key)) {
            return this.llms.get(key)!;
        }

        const llm = await this.createModel(selectedModel, options);
        if (!isRemoteBedrock) {
            this.llms.set(key, llm);
        }
        return llm;
    }

    public async prompt(
        messages: BaseMessage[],
        model?: LLMModel,
        options?: LLMOptions,
        tracking?: { tracker: TokenUsageTracker; label: string },
    ): Promise<string> {
        const selectedModel = model ?? (await this.config.getModel());
        const provider = getModelProvider(selectedModel) as AIProvider;
        const llm = await this.getModel(model, options);
        let response: any;
        try {
            response = await llm.invoke(messages);
        } catch (e) {
            if (tracking) {
                tracking.tracker.record(`${tracking.label} (failed)`, {
                    inputTokens: null,
                    outputTokens: null,
                });
            }
            throw e;
        }

        // Extract and record token usage if tracking is enabled
        if (tracking) {
            const usageMeta: UsageMetadata | undefined =
                "usage_metadata" in response ? (response.usage_metadata as UsageMetadata) : undefined;
            const input = typeof usageMeta?.input_tokens === "number" ? usageMeta.input_tokens : null;
            const total = typeof usageMeta?.total_tokens === "number" ? usageMeta.total_tokens : null;

            // For Gemini models, usage_metadata.output_tokens only includes visible candidates,
            // omitting reasoning/thinking tokens. Total includes thinking tokens and is billed at output rate.
            const output =
                provider === AIProvider.GOOGLE && total !== null && input !== null
                    ? total - input
                    : typeof usageMeta?.output_tokens === "number"
                      ? usageMeta.output_tokens
                      : null;

            tracking.tracker.record(tracking.label, {
                inputTokens: input,
                outputTokens: output,
            });
        }

        return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    }

    /**
     * Resolves both the AIProvider and wire model name in a single config lookup.
     */
    public async resolveSessionInfo(model?: LLMModel): Promise<{ provider: AIProvider; model: string }> {
        const selectedModel = model ?? (await this.config.getModel());
        const provider = getModelProvider(selectedModel);
        const resolvedModel = await this.resolveModel(selectedModel);
        return { provider, model: resolvedModel };
    }

    /**
     * Resolves the AIProvider enum value for a given model (or configured model if omitted).
     */
    public async resolveProvider(model?: LLMModel): Promise<AIProvider> {
        const selectedModel = model ?? (await this.config.getModel());
        return getModelProvider(selectedModel);
    }

    /**
     * Resolves the actual wire model name that will be used (respecting provider configs, region prefixes, & env vars).
     */
    public async resolveModel(model?: LLMModel): Promise<string> {
        const selectedModel = model ?? (await this.config.getModel());
        const provider = getModelProvider(selectedModel);

        switch (provider) {
            case AIProvider.BEDROCK: {
                const providerConfig = await this.config.getProviderConfig(AIProvider.BEDROCK);
                const region = providerConfig?.awsRegion ?? process.env.AWS_REGION ?? "us-east-1";
                const targetModel =
                    selectedModel === LLMModel.BEDROCK_CUSTOM
                        ? (providerConfig?.model ?? selectedModel)
                        : (selectedModel as string);
                return targetModel.startsWith("anthropic.")
                    ? `${bedrockInferenceProfilePrefix(region)}.${targetModel}`
                    : targetModel;
            }
            case AIProvider.OLLAMA: {
                if (selectedModel === LLMModel.OLLAMA_CUSTOM) {
                    const providerConfig = await this.config.getProviderConfig(AIProvider.OLLAMA);
                    return providerConfig?.model ?? "llama3";
                }
                return selectedModel as string;
            }
            case AIProvider.SELF_HOSTED: {
                if (selectedModel === LLMModel.SELF_HOSTED_CUSTOM) {
                    const providerConfig = await this.config.getProviderConfig(AIProvider.SELF_HOSTED);
                    return providerConfig?.model ?? process.env.SELF_HOSTED_MODEL ?? selectedModel;
                }
                return selectedModel as string;
            }
            case AIProvider.AZURE_OPENAI: {
                // The deployment name is the wire model; same precedence as createAzureOpenAIModel.
                const providerConfig = await this.config.getProviderConfig(AIProvider.AZURE_OPENAI);
                const rawEndpoint = providerConfig?.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
                return (
                    providerConfig?.azureDeploymentName ??
                    process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??
                    process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ??
                    (rawEndpoint ? parseAzureOpenAITarget(rawEndpoint).deploymentName : undefined) ??
                    selectedModel
                );
            }
            case AIProvider.AZURE_FOUNDRY: {
                const providerConfig = await this.config.getProviderConfig(AIProvider.AZURE_FOUNDRY);
                return providerConfig?.azureDeploymentName ?? process.env.AZURE_FOUNDRY_DEPLOYMENT ?? selectedModel;
            }
            default:
                return selectedModel as string;
        }
    }

    private async createModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const provider = getModelProvider(model);
        switch (provider) {
            case AIProvider.ANTHROPIC:
                return this.createAnthropicModel(model, options);
            case AIProvider.BEDROCK:
                return this.createBedrockModel(model, options);
            case AIProvider.GOOGLE:
                return this.createGeminiModel(model, options);
            case AIProvider.OPENAI:
                return this.createOpenAIModel(model, options);
            case AIProvider.AZURE_OPENAI:
                return this.createAzureOpenAIModel(options);
            case AIProvider.AZURE_FOUNDRY:
                return this.createAzureFoundryModel(options);
            case AIProvider.XAI:
                return this.createGrokModel(model, options);
            case AIProvider.DEEPSEEK:
                return this.createDeepSeekModel(model, options);
            case AIProvider.OLLAMA:
                return this.createOllamaModel(model, options);
            case AIProvider.SELF_HOSTED:
                return this.createSelfHostedModel(model, options);
            default:
                throw new Error(`Unsupported model: ${model}`);
        }
    }

    // --- Anthropic (direct API) ---

    private async createAnthropicModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.ANTHROPIC);
        const { ChatAnthropic } = await import("@langchain/anthropic");
        return new ChatAnthropic({
            modelName: model,
            anthropicApiKey: apiKey,
            temperature: options?.temperature ?? 0,
            maxTokens: 8192,
        });
    }

    // --- AWS Bedrock ---

    private async createBedrockModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const { ChatBedrockConverse } = await import("@langchain/aws");
        const providerConfig = await this.config.getProviderConfig(AIProvider.BEDROCK);
        let region = providerConfig?.awsRegion ?? process.env.AWS_REGION;
        if (!region) {
            region = "us-east-1";
            logger.warn(
                "AWS Bedrock region is not configured — defaulting to us-east-1. Run 'sat-cli init' to set one explicitly.",
            );
        }
        const profile = providerConfig?.awsProfile ?? process.env.AWS_PROFILE;

        // Credential resolution precedence:
        // 1. Remote credential mode (SAT_REMOTE_URL / SATENG_REMOTE_URL or config.remote)
        // 2. AWS Profile (providerConfig.awsProfile or AWS_PROFILE)
        // 3. Default AWS credential chain (environment variables / IAM roles / ~/.aws/credentials)
        //
        // When remote mode is enabled, fresh credentials are affirmatively fetched via
        // getCredentials() before invocation and passed as static credentials into a
        // client used for that one invocation (bypassing this.llms client caching and
        // AWS SDK credential memoization).
        const remote = await this.config.getRemoteConfig();
        let credentials: any;
        if (remote) {
            logger.debug("Fetching fresh remote AWS credentials for Bedrock invocation.");
            const remoteCreds = await this.remoteCredentials.getCredentials();
            credentials = {
                accessKeyId: remoteCreds.accessKeyId,
                secretAccessKey: remoteCreds.secretAccessKey,
                ...(remoteCreds.sessionToken ? { sessionToken: remoteCreds.sessionToken } : {}),
            };
        } else if (profile) {
            credentials = (await import("@aws-sdk/credential-providers")).fromIni({ profile });
        } else {
            credentials = undefined;
        }

        if (model === LLMModel.BEDROCK_CUSTOM && !providerConfig?.model) {
            throw new Error(
                "Custom Bedrock model ID or ARN is required. Run 'sat-cli init' to configure your custom Bedrock model.",
            );
        }

        const resolvedModel = await this.resolveModel(model);
        // The id actually sent: a "model identifier is invalid" error from Bedrock is about this,
        // not about the configured model, and it is otherwise invisible in the logs.
        logger.debug(`Bedrock: invoking ${resolvedModel} in ${region}.`);

        return new ChatBedrockConverse({
            model: resolvedModel,
            region,
            credentials,
            temperature: options?.temperature ?? 0,
            maxTokens: 8192,
        });
    }

    // --- Google Gemini ---

    private async createGeminiModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.GOOGLE);
        const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
        return new ChatGoogleGenerativeAI({
            model,
            apiKey,
            temperature: options?.temperature ?? 0,
            maxOutputTokens: 8192,
        });
    }

    // --- OpenAI ---

    private async createOpenAIModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.OPENAI);
        const providerConfig = await this.config.getProviderConfig(AIProvider.OPENAI);
        const baseUrl = providerConfig?.baseUrl ?? process.env.OPENAI_BASE_URL;

        const { ChatOpenAI } = await import("@langchain/openai");

        const openAIConfig: any = {
            modelName: model,
            openAIApiKey: apiKey,
            temperature: options?.temperature ?? 0,
        };

        // Only add baseURL if it's configured (don't add undefined)
        if (baseUrl) {
            openAIConfig.configuration = {
                baseURL: baseUrl,
            };
        }

        return new ChatOpenAI(openAIConfig);
    }

    // --- Azure OpenAI ---

    private async createAzureOpenAIModel(options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.AZURE_OPENAI);
        const providerConfig = await this.config.getProviderConfig(AIProvider.AZURE_OPENAI);

        const rawEndpoint = providerConfig?.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
        if (!rawEndpoint) {
            throw new Error("Azure OpenAI endpoint is required. Set AZURE_OPENAI_ENDPOINT or run 'sat-cli init'.");
        }
        // The endpoint may be the portal's full Target URI; whatever it carries fills in the
        // deployment and API version, and explicitly configured values win over it.
        const target = parseAzureOpenAITarget(rawEndpoint);

        // AZURE_OPENAI_API_DEPLOYMENT_NAME is what @langchain/openai reads natively; accept the
        // shorter AZURE_OPENAI_DEPLOYMENT_NAME too since that's the name Azure's own docs use.
        const deploymentName =
            providerConfig?.azureDeploymentName ??
            process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??
            process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ??
            target.deploymentName;
        const apiVersion =
            providerConfig?.azureApiVersion ??
            process.env.AZURE_OPENAI_API_VERSION ??
            target.apiVersion ??
            DEFAULT_AZURE_OPENAI_API_VERSION;

        if (!deploymentName) {
            throw new Error(
                "Azure OpenAI deployment name is required. Set AZURE_OPENAI_DEPLOYMENT_NAME or run 'sat-cli init'.",
            );
        }

        const { AzureChatOpenAI } = await import("@langchain/openai");

        // getEndpoint() builds "<endpoint>/openai/deployments/<deployment>", so the endpoint must
        // be the bare resource URL with no trailing slash.
        return new AzureChatOpenAI({
            model: deploymentName,
            azureOpenAIApiKey: apiKey,
            azureOpenAIEndpoint: target.endpoint,
            azureOpenAIApiDeploymentName: deploymentName,
            azureOpenAIApiVersion: apiVersion,
            maxRetries: AZURE_MAX_RETRIES,
            // Left unset for models that reject anything but their default, so the request
            // carries no temperature at all.
            temperature: azureOpenAIAcceptsTemperature(deploymentName) ? (options?.temperature ?? 0) : undefined,
        });
    }

    // --- Claude on Azure AI Foundry ---

    private async createAzureFoundryModel(options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.AZURE_FOUNDRY);
        const providerConfig = await this.config.getProviderConfig(AIProvider.AZURE_FOUNDRY);

        const endpoint = providerConfig?.azureEndpoint ?? process.env.AZURE_FOUNDRY_ENDPOINT;
        const deploymentName = providerConfig?.azureDeploymentName ?? process.env.AZURE_FOUNDRY_DEPLOYMENT;

        if (!endpoint) {
            throw new Error("Azure AI Foundry endpoint is required. Set AZURE_FOUNDRY_ENDPOINT or run 'sat-cli init'.");
        }
        if (!deploymentName) {
            throw new Error(
                "Azure AI Foundry deployment name is required. Set AZURE_FOUNDRY_DEPLOYMENT or run 'sat-cli init'.",
            );
        }

        // Foundry serves Claude through Anthropic's own Messages API, so the Anthropic client works
        // unchanged once pointed at the resource; the deployment name is what goes in `model`.
        const { ChatAnthropic } = await import("@langchain/anthropic");
        return new ChatAnthropic({
            model: deploymentName.trim(),
            apiKey,
            anthropicApiUrl: azureFoundryAnthropicBaseUrl(endpoint),
            temperature: options?.temperature ?? 0,
            maxTokens: 8192,
            maxRetries: AZURE_MAX_RETRIES,
        });
    }

    // --- xAI (Grok) ---

    private async createGrokModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.XAI);
        const { ChatXAI } = await import("@langchain/xai");
        return new ChatXAI({
            model,
            apiKey,
            temperature: options?.temperature ?? 0,
        });
    }

    // --- DeepSeek ---

    private async createDeepSeekModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const apiKey = await this.config.getApiKey(AIProvider.DEEPSEEK);
        const { ChatOpenAI } = await import("@langchain/openai");
        return new ChatOpenAI({
            modelName: model,
            openAIApiKey: apiKey,
            temperature: options?.temperature ?? 0,
            configuration: {
                baseURL: "https://api.deepseek.com",
            },
        });
    }

    // --- Ollama (local) ---

    private async createOllamaModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const { ChatOllama } = await import("@langchain/ollama");
        const providerConfig = await this.config.getProviderConfig(AIProvider.OLLAMA);
        const baseUrl = normalizeBaseUrl(
            providerConfig?.baseUrl ??
                providerConfig?.ollamaBaseUrl ??
                process.env.OLLAMA_BASE_URL ??
                DEFAULT_OLLAMA_BASE_URL,
        );
        const apiToken = providerConfig?.apiToken ?? process.env.OLLAMA_API_TOKEN;

        const modelName = await this.resolveModel(model);
        if (model === LLMModel.OLLAMA_CUSTOM) {
            logger.info(`Using custom Ollama model: ${modelName}`);
        }

        return new ChatOllama({
            model: modelName,
            baseUrl,
            headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined,
            temperature: options?.temperature ?? 0,
        });
    }

    // --- Self-hosted ---

    private async createSelfHostedModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const providerConfig = await this.config.getProviderConfig(AIProvider.SELF_HOSTED);
        const endpoint = providerConfig?.endpoint ?? process.env.SELF_HOSTED_ENDPOINT;
        const modelName = await this.resolveModel(model);

        if (!endpoint) {
            throw new Error(
                "Self-hosted model endpoint URL is required. Set SELF_HOSTED_ENDPOINT or run 'sat-cli init'.",
            );
        }

        if (!modelName || modelName === LLMModel.SELF_HOSTED_CUSTOM) {
            throw new Error("Self-hosted model name is required. Set SELF_HOSTED_MODEL or run 'sat-cli init'.");
        }

        const accessToken = getSelfHostedAuthToken(providerConfig);
        const timeoutMs = Number(process.env.SELF_HOSTED_TIMEOUT_MS ?? DEFAULT_SELF_HOSTED_TIMEOUT_MS);

        const invokeSelfHosted = async (messages: BaseMessage[]) => {
            const url = `${normalizeBaseUrl(endpoint)}/api/chat`;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

            let response: Response;
            try {
                response = await fetch(url, {
                    method: "POST",
                    headers,
                    signal: AbortSignal.timeout(timeoutMs),
                    body: JSON.stringify({
                        model: modelName,
                        stream: true,
                        messages: toOllamaChatMessages(messages),
                        options: { temperature: options?.temperature ?? 0 },
                    }),
                });
            } catch (error) {
                if (isAbortError(error)) {
                    throw new Error(`Self-hosted LLM request timed out after ${timeoutMs}ms.`);
                }
                throw new Error(`Self-hosted LLM endpoint is not reachable at ${url}: ${getErrorMessage(error)}`);
            }

            if (!response.ok) {
                const body = await response.text().catch(() => "");
                if (response.status === 404 || /model.*not found|not found.*model/i.test(body)) {
                    throw new Error(
                        `Self-hosted LLM model '${modelName}' was not found on ${normalizeBaseUrl(endpoint)}.`,
                    );
                }
                throw new Error(
                    `Self-hosted LLM request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
                );
            }

            let body: string;
            try {
                body = await response.text();
            } catch {
                throw new Error("Self-hosted LLM response stream failed.");
            }

            return parseOllamaChatResponse(body);
        };

        return {
            invoke: async (messages: BaseMessage[]) => {
                const current = this.selfHostedQueue.then(
                    () => invokeSelfHosted(messages),
                    () => invokeSelfHosted(messages),
                );
                this.selfHostedQueue = current.then(
                    () => undefined,
                    () => undefined,
                );
                return current;
            },
        };
    }
}
