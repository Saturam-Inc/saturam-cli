import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";

const logger = getLogger("SlackSettings");

/**
 * Environment variables the Slack bot reads. The knowledge base, model, bucket and conversation
 * table are configured through the SATENG_* variables in config-environment.ts, shared with the
 * CLI; these are only what is specific to talking to Slack.
 */
export const SLACK_ENV = {
    /** Secrets Manager secret id/ARN holding SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET as JSON. */
    SECRET_ID: "SLACK_SECRET_ID",
    /** Direct values — local development only. They win over SLACK_SECRET_ID when set. */
    BOT_TOKEN: "SLACK_BOT_TOKEN",
    SIGNING_SECRET: "SLACK_SIGNING_SECRET",
    /** App-level token (xapp-…) for Socket Mode. Local development only. */
    APP_TOKEN: "SLACK_APP_TOKEN",
    /** SQS FIFO queue the ingress hands questions to. Unset means answer in-process (local dev). */
    JOB_QUEUE_URL: "SLACK_JOB_QUEUE_URL",
    /** Comma-separated workspace ids (T…) the bot answers in. Empty means any workspace it is installed in. */
    ALLOWED_TEAM_IDS: "SLACK_ALLOWED_TEAM_IDS",
    /** Comma-separated channel ids (C…/G…) the bot answers mentions in. Empty means every channel it is in. */
    ALLOWED_CHANNEL_IDS: "SLACK_ALLOWED_CHANNEL_IDS",
    /** "false" to turn off answering in direct messages. */
    ALLOW_DIRECT_MESSAGES: "SLACK_ALLOW_DIRECT_MESSAGES",
    /**
     * Attempts the worker makes at a question before giving up and telling the user. Must equal
     * the queue's redrive "maximum receives", or the last attempt never gets to post its apology.
     */
    WORKER_MAX_ATTEMPTS: "SLACK_WORKER_MAX_ATTEMPTS",
} as const;

export interface SlackAccessPolicy {
    allowedTeamIds: ReadonlySet<string>;
    allowedChannelIds: ReadonlySet<string>;
    allowDirectMessages: boolean;
}

export interface SlackSettingsValues {
    secretId?: string;
    jobQueueUrl?: string;
    access: SlackAccessPolicy;
    workerMaxAttempts: number;
}

export interface SlackCredentials {
    botToken: string;
    signingSecret: string;
}

const SecretPayloadSchema = z.object({
    SLACK_BOT_TOKEN: z.string().min(1),
    SLACK_SIGNING_SECRET: z.string().min(1),
});

/**
 * Whether the bot may answer in this conversation. Direct messages are governed only by the
 * workspace and DM switches: the allow-list exists to keep answers out of channels where they
 * would be seen by people the knowledge base was not meant for, and a DM has no such audience.
 */
export function isConversationAllowed(
    policy: SlackAccessPolicy,
    conversation: { teamId: string; channelId: string; isDirectMessage: boolean },
): boolean {
    if (policy.allowedTeamIds.size > 0 && !policy.allowedTeamIds.has(conversation.teamId)) return false;
    if (conversation.isDirectMessage) return policy.allowDirectMessages;
    return policy.allowedChannelIds.size === 0 || policy.allowedChannelIds.has(conversation.channelId);
}

function csv(value: string | undefined): Set<string> {
    return new Set(
        (value ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
    );
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer, got "${value}".`);
    }
    return parsed;
}

/** Pure, so tests can hand it an environment instead of mutating process.env. */
export function readSlackSettings(env: Record<string, string | undefined>): SlackSettingsValues {
    return {
        secretId: env[SLACK_ENV.SECRET_ID]?.trim() || undefined,
        jobQueueUrl: env[SLACK_ENV.JOB_QUEUE_URL]?.trim() || undefined,
        access: {
            allowedTeamIds: csv(env[SLACK_ENV.ALLOWED_TEAM_IDS]),
            allowedChannelIds: csv(env[SLACK_ENV.ALLOWED_CHANNEL_IDS]),
            allowDirectMessages: env[SLACK_ENV.ALLOW_DIRECT_MESSAGES]?.trim().toLowerCase() !== "false",
        },
        workerMaxAttempts: positiveInt(env[SLACK_ENV.WORKER_MAX_ATTEMPTS], 2, SLACK_ENV.WORKER_MAX_ATTEMPTS),
    };
}

/**
 * Runtime settings for the Slack bot, read from the environment once per process.
 *
 * Slack credentials come from Secrets Manager in AWS and from plain variables locally. They are
 * fetched lazily and cached for the life of the process: a warm Lambda then pays for the lookup
 * once, and a rotated secret takes effect on the next cold start.
 */
@Service()
export class SlackSettings {
    private values: SlackSettingsValues | undefined;
    private credentials: Promise<SlackCredentials> | undefined;

    public get(): SlackSettingsValues {
        this.values ??= readSlackSettings(process.env);
        return this.values;
    }

    public getCredentials(): Promise<SlackCredentials> {
        this.credentials ??= this.loadCredentials().catch((err) => {
            // Do not cache a failure: the next event should try again rather than fail forever.
            this.credentials = undefined;
            throw err;
        });
        return this.credentials;
    }

    private async loadCredentials(): Promise<SlackCredentials> {
        const botToken = process.env[SLACK_ENV.BOT_TOKEN]?.trim();
        const signingSecret = process.env[SLACK_ENV.SIGNING_SECRET]?.trim();
        // Socket Mode (local) never sees a signed request, so a bot token alone is enough there.
        // The HTTP ingress refuses to run with an empty signing secret rather than skip the check.
        if (botToken) return { botToken, signingSecret: signingSecret ?? "" };

        const { secretId } = this.get();
        if (!secretId) {
            throw new Error(
                `Slack credentials are not configured: set ${SLACK_ENV.SECRET_ID} to a Secrets Manager secret, ` +
                    `or ${SLACK_ENV.BOT_TOKEN} and ${SLACK_ENV.SIGNING_SECRET} for local development.`,
            );
        }

        const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
        const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
        if (!response.SecretString) {
            throw new Error(`Secret ${secretId} has no string value — store it as JSON key/value pairs.`);
        }

        const parsed = SecretPayloadSchema.safeParse(JSON.parse(response.SecretString));
        if (!parsed.success) {
            throw new Error(`Secret ${secretId} must contain SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.`);
        }
        logger.debug(`Loaded Slack credentials from ${secretId}.`);
        return { botToken: parsed.data.SLACK_BOT_TOKEN, signingSecret: parsed.data.SLACK_SIGNING_SECRET };
    }
}
