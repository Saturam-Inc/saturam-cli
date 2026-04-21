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
} from "../constants/llm-models";
import { AIProvider, ConfigService } from "./config-service";

const logger = getLogger("LlmService");

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

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
        const baseUrl = providerConfig?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;

        // For custom models, use the customModel name from config
        const modelName = model === LLMModel.OLLAMA_CUSTOM
            ? (providerConfig?.customModel ?? "llama3")
            : model as string;
        if (model === LLMModel.OLLAMA_CUSTOM) {
            logger.info(`Using custom Ollama model: ${modelName}`);
        }

        return new ChatOllama({
            model: modelName,
            baseUrl,
            temperature: options?.temperature ?? 0,
        });
    }
}
