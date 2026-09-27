import { getLogger } from "log4js";
import { ContainerInstance } from "typedi";
import { z } from "zod";
import { LLMModel, isAzureFoundryModel, isAzureOpenAIModel, isBedrockModel } from "../constants/llm-models";
import { ConfigService } from "../services/config-service";

const logger = getLogger("SlackLambdaRuntime");

/**
 * What is true of the Slack bot on Lambda and of nothing else.
 *
 * The Lambda artifact carries only the `onboard` path and the model providers the bot is
 * deployed with (deploy/slack-bot/build.mjs leaves every other provider out), and it has no home
 * directory for a config file.
 */

/** Points at a Secrets Manager secret holding the model provider's credentials. */
export const LLM_SECRET_ENV = "SATENG_LLM_SECRET_ID";

/**
 * The keys the model-credentials secret may hold — exactly the environment variables LlmService
 * already reads for these providers. Anything else in the secret is ignored, so the secret cannot
 * be used to rewrite unrelated settings.
 */
export const LLM_SECRET_KEYS = [
    // A GPT deployment on Azure AI Foundry / Azure OpenAI
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_SUPPORTS_TEMPERATURE",
    // Claude on Azure AI Foundry
    "AZURE_FOUNDRY_API_KEY",
    "AZURE_FOUNDRY_ENDPOINT",
    "AZURE_FOUNDRY_DEPLOYMENT",
] as const;

/**
 * ConfigService looks for a personal config file. On Lambda only /tmp is writable and nothing is
 * expected there — configuration comes from SATENG_* variables — so point it somewhere harmless
 * rather than at a home directory the runtime may not have. Must run before the container is built.
 */
export function prepareLambdaEnvironment(): void {
    process.env.SATENG_CONFIG_DIR ??= "/tmp/sateng";
}

/**
 * Copies the recognised keys of a credentials secret into the environment, where LlmService reads
 * them. A variable already set on the function wins, so a value can be overridden without editing
 * the secret. Returns the keys applied, for the log; never their values.
 */
export function applyLlmSecret(secret: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string[] {
    const applied: string[] = [];
    for (const key of LLM_SECRET_KEYS) {
        const value = secret[key];
        if (typeof value === "string" && value.trim() && !env[key]) {
            env[key] = value.trim();
            applied.push(key);
        }
    }
    return applied;
}

let llmSecretLoad: Promise<void> | undefined;

/**
 * Loads the model provider's credentials from Secrets Manager, once per cold start. A no-op when
 * SATENG_LLM_SECRET_ID is unset — Bedrock, for one, needs no credentials beyond the role.
 *
 * Keys stay in memory for the life of the process and are never written to logs; a rotated secret
 * takes effect on the next cold start.
 */
export function loadLlmCredentials(): Promise<void> {
    const secretId = process.env[LLM_SECRET_ENV]?.trim();
    if (!secretId) return Promise.resolve();

    llmSecretLoad ??= (async () => {
        const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
        const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
        const parsed = z.record(z.unknown()).safeParse(JSON.parse(response.SecretString ?? "null"));
        if (!parsed.success) {
            throw new Error(`Secret ${secretId} must be JSON key/value pairs (${LLM_SECRET_KEYS.join(", ")}).`);
        }
        const applied = applyLlmSecret(parsed.data);
        logger.info(`Loaded model credentials from ${secretId}: ${applied.join(", ") || "no recognised keys"}.`);
    })().catch((err) => {
        // Not cached: the next invocation should try again rather than stay broken until a cold start.
        llmSecretLoad = undefined;
        throw err;
    });
    return llmSecretLoad;
}

/**
 * Why the configured model cannot run in the Lambda build, or undefined when it can. Without
 * SATENG_MODEL the CLI's default applies — Anthropic's direct API, which the bundle does not
 * support — so the bot would otherwise fail every question with an unhelpful error.
 */
export function lambdaModelProblem(model: LLMModel): string | undefined {
    if (isAzureFoundryModel(model) || isAzureOpenAIModel(model) || isBedrockModel(model)) return undefined;
    return (
        `The configured model "${model}" is not supported by the Slack bot's Lambda build, which runs on ` +
        `Bedrock or Azure AI Foundry. Set SATENG_MODEL on the worker to a Bedrock model id such as ` +
        `${LLMModel.BEDROCK_CLAUDE_4_6_SONNET}, or to ${LLMModel.AZURE_OPENAI_CUSTOM} (a GPT deployment) ` +
        `or ${LLMModel.AZURE_FOUNDRY_CLAUDE} (Claude on Foundry).`
    );
}

let modelChecked = false;

/** Logs a misconfigured model once per cold start, loudly, where the logs are first looked at. */
export async function reportModelMisconfiguration(container: ContainerInstance): Promise<void> {
    if (modelChecked) return;
    modelChecked = true;
    const problem = lambdaModelProblem(await container.get(ConfigService).getModel());
    if (problem) logger.error(problem);
}
