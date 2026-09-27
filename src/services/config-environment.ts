/**
 * Personal configuration supplied through environment variables.
 *
 * The CLI keeps its configuration in a JSON file that `sat-cli init` writes. A server deployment —
 * the Slack bot on Lambda — has no home directory to put one in and no terminal to run the wizard
 * from, so the same settings come from its environment instead. Credentials are deliberately not
 * among them: on AWS the execution role supplies those through the SDK's default provider chain,
 * which is what `resolveAwsClientConfig` falls back to when no profile or key is configured.
 *
 * Values here win over the file, field by field, so a developer can also point a local run at a
 * different knowledge base or table without editing their saved config.
 *
 * The names are a deployment contract: the Slack bot's private deployment sets them on its Lambda
 * functions (docs/SLACK-BOT.md, "Deployment contract"). Renaming one means a minor version bump and
 * a note in the release, so the deployer changes the function settings in the same step.
 */

export const CONFIG_ENV = {
    /** Model id from LLMModel, e.g. "anthropic.claude-sonnet-4-5-20250929-v1:0". */
    MODEL: "SATENG_MODEL",
    /** Region Bedrock chat models are invoked in. Defaults to AWS_REGION. */
    BEDROCK_REGION: "SATENG_BEDROCK_REGION",
    /** Default region for the cloud services below. Defaults to AWS_REGION. */
    AWS_REGION: "SATENG_AWS_REGION",
    KB_ID: "SATENG_KB_ID",
    KB_DATA_SOURCE_ID: "SATENG_KB_DATA_SOURCE_ID",
    KB_REGION: "SATENG_KB_REGION",
    S3_BUCKET: "SATENG_S3_BUCKET",
    S3_PREFIX: "SATENG_S3_PREFIX",
    S3_STATE_PREFIX: "SATENG_S3_STATE_PREFIX",
    S3_REGION: "SATENG_S3_REGION",
    CONVERSATION_TABLE: "SATENG_CONVERSATION_TABLE",
    CONVERSATION_TABLE_REGION: "SATENG_CONVERSATION_TABLE_REGION",
    CONVERSATION_TTL_DAYS: "SATENG_CONVERSATION_TTL_DAYS",
} as const;

type Env = Record<string, string | undefined>;
type RawConfig = Record<string, any>;

function read(env: Env, name: string): string | undefined {
    const value = env[name]?.trim();
    return value ? value : undefined;
}

/** Drops undefined fields so a merge never overwrites a file value with "not set". */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function isEmpty(value: Record<string, unknown>): boolean {
    return Object.keys(value).length === 0;
}

/**
 * The part of a personal configuration the environment defines, in the file's raw shape, or
 * undefined when none of the variables is set. Validation is left to the configuration schema,
 * so an environment value is held to exactly the rules a saved one is.
 */
export function personalConfigFromEnvironment(env: Env = process.env): RawConfig | undefined {
    const overlay: RawConfig = {};
    const awsRegion = read(env, CONFIG_ENV.AWS_REGION) ?? read(env, "AWS_REGION");

    const model = read(env, CONFIG_ENV.MODEL);
    if (model) overlay.defaultModel = model;

    const bedrockRegion = read(env, CONFIG_ENV.BEDROCK_REGION);
    if (bedrockRegion) overlay.providers = { bedrock: { enabled: true, awsRegion: bedrockRegion } };

    const knowledgeBaseId = read(env, CONFIG_ENV.KB_ID);
    const bucket = read(env, CONFIG_ENV.S3_BUCKET);
    const tableName = read(env, CONFIG_ENV.CONVERSATION_TABLE);

    const aws: RawConfig = {};
    if (knowledgeBaseId) {
        aws.bedrockKnowledgeBase = defined({
            knowledgeBaseId,
            dataSourceId: read(env, CONFIG_ENV.KB_DATA_SOURCE_ID),
            region: read(env, CONFIG_ENV.KB_REGION),
        });
    }
    if (bucket) {
        aws.s3 = defined({
            bucket,
            prefix: read(env, CONFIG_ENV.S3_PREFIX),
            statePrefix: read(env, CONFIG_ENV.S3_STATE_PREFIX),
            region: read(env, CONFIG_ENV.S3_REGION),
        });
    }
    if (tableName) {
        const ttlDays = read(env, CONFIG_ENV.CONVERSATION_TTL_DAYS);
        aws.conversationTable = defined({
            tableName,
            region: read(env, CONFIG_ENV.CONVERSATION_TABLE_REGION),
            // Left as NaN when unparseable so the schema rejects it by name rather than dropping it.
            ttlDays: ttlDays === undefined ? undefined : Number(ttlDays),
        });
    }
    if (!isEmpty(aws)) {
        overlay.cloud = { aws: { enabled: true, ...defined({ awsRegion }), ...aws } };
    }

    return isEmpty(overlay) ? undefined : overlay;
}

/**
 * Lays the environment's configuration over the file's. Objects merge one level into the
 * provider and cloud sections, so setting SATENG_KB_ID replaces the knowledge base block but
 * leaves a saved S3 block, provider API keys and the rest of the file alone.
 */
export function mergePersonalConfig(file: unknown, overlay: RawConfig | undefined): unknown {
    if (!overlay) return file;
    const base: RawConfig = file && typeof file === "object" ? { ...(file as RawConfig) } : {};

    if (overlay.defaultModel) base.defaultModel = overlay.defaultModel;

    for (const [provider, config] of Object.entries(overlay.providers ?? {})) {
        base.providers = { ...(base.providers ?? {}) };
        base.providers[provider] = { ...(base.providers[provider] ?? {}), ...(config as RawConfig) };
    }

    for (const [provider, config] of Object.entries(overlay.cloud ?? {})) {
        base.cloud = { ...(base.cloud ?? {}) };
        base.cloud[provider] = { ...(base.cloud[provider] ?? {}), ...(config as RawConfig) };
    }

    return base;
}
