import type { BaseMessage } from "@langchain/core/messages";
import { getLogger } from "log4js";
import { Service } from "typedi";
import {
    ChatModel,
    LLMModel,
    LLMOptions,
    isAnthropicModel,
    isBedrockModel,
    isDeepSeekModel,
    isGeminiModel,
    isGrokModel,
    isOllamaModel,
    isOpenAIModel,
    isSelfHostedModel,
} from "../constants/llm-models";
import { AIProvider, ConfigService, ProviderConfig } from "./config-service";

const logger = getLogger("LlmService");

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_SELF_HOSTED_TIMEOUT_MS = 120000;

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}

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

@Service()
export class LlmService {
    private llms: Map<string, ChatModel> = new Map();

    constructor(private readonly config: ConfigService) {}

    public async getModel(model?: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        const selectedModel = model ?? (await this.config.getModel());
        const key = `${selectedModel}:${JSON.stringify(options ?? {})}`;

        if (this.llms.has(key)) {
            return this.llms.get(key)!;
        }

        const llm = await this.createModel(selectedModel, options);
        this.llms.set(key, llm);
        return llm;
    }

    public async prompt(messages: BaseMessage[], model?: LLMModel, options?: LLMOptions): Promise<string> {
        const llm = await this.getModel(model, options);
        const response = await llm.invoke(messages);
        return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    }

    private async createModel(model: LLMModel, options?: LLMOptions): Promise<ChatModel> {
        if (isAnthropicModel(model)) return this.createAnthropicModel(model, options);
        if (isBedrockModel(model)) return this.createBedrockModel(model, options);
        if (isGeminiModel(model)) return this.createGeminiModel(model, options);
        if (isOpenAIModel(model)) return this.createOpenAIModel(model, options);
        if (isGrokModel(model)) return this.createGrokModel(model, options);
        if (isDeepSeekModel(model)) return this.createDeepSeekModel(model, options);
        if (isOllamaModel(model)) return this.createOllamaModel(model, options);
        if (isSelfHostedModel(model)) return this.createSelfHostedModel(model, options);
        throw new Error(`Unsupported model: ${model}`);
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
        const region = providerConfig?.awsRegion ?? process.env.AWS_REGION ?? "us-east-1";
        const profile = providerConfig?.awsProfile ?? process.env.AWS_PROFILE;

        const credentials: any = profile
            ? (await import("@aws-sdk/credential-providers")).fromIni({ profile })
            : undefined;

        return new ChatBedrockConverse({
            model,
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
        const { ChatOpenAI } = await import("@langchain/openai");
        return new ChatOpenAI({
            modelName: model,
            openAIApiKey: apiKey,
            temperature: options?.temperature ?? 0,
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
            providerConfig?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
        );
        const apiToken = providerConfig?.apiToken ?? process.env.OLLAMA_API_TOKEN;

        // For remote/custom Ollama deployments, prefer the exact configured model name.
        const modelName =
            providerConfig?.model ??
            (model === LLMModel.OLLAMA_CUSTOM ? (providerConfig?.customModel ?? "llama3") : (model as string));
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
        const endpoint =
            providerConfig?.endpoint ?? providerConfig?.selfHostedEndpoint ?? process.env.SELF_HOSTED_ENDPOINT;
        const modelName =
            providerConfig?.model ??
            providerConfig?.customModel ??
            process.env.SELF_HOSTED_MODEL ??
            "selfhosted-custom";
        const accessToken = getSelfHostedAuthToken(providerConfig);
        const timeoutMs = Number(process.env.SELF_HOSTED_TIMEOUT_MS ?? DEFAULT_SELF_HOSTED_TIMEOUT_MS);

        if (!endpoint) {
            throw new Error(
                "Self-hosted model endpoint URL is required. Set SELF_HOSTED_ENDPOINT or run 'sat-cli init'.",
            );
        }

        return {
            invoke: async (messages: BaseMessage[]) => {
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
                            stream: false,
                            messages: toOllamaChatMessages(messages),
                            options: { temperature: options?.temperature ?? 0 },
                        }),
                    });
                } catch (error) {
                    if (isAbortError(error)) {
                        throw new Error(`Self-hosted LLM request timed out after ${timeoutMs}ms.`);
                    }
                    throw new Error(`Self-hosted LLM endpoint is not reachable at ${url}.`);
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

                let data: unknown;
                try {
                    data = await response.json();
                } catch {
                    throw new Error("Self-hosted LLM returned an invalid JSON response.");
                }

                const content = (data as { message?: { content?: unknown } }).message?.content;
                if (typeof content !== "string") {
                    throw new Error("Self-hosted LLM returned an invalid response: missing message.content.");
                }

                return { content };
            },
        };
    }
}
