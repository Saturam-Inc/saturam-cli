import type { WebClient } from "@slack/web-api";
import { Service } from "typedi";
import { SlackSettings } from "./slack-settings";
import type { SlackMessage } from "./slack-messages";

/**
 * The bot's outbound side: the handful of Slack Web API calls it makes, behind one class so the
 * ingress and worker depend on "post", "update" and "whisper" rather than on the SDK.
 *
 * Needs the bot token scopes `chat:write` (and `im:write` for DMs, which Slack grants with the
 * Messages tab); see docs/SLACK-BOT.md.
 */
@Service()
export class SlackGateway {
    private client: Promise<WebClient> | undefined;

    constructor(private readonly settings: SlackSettings) {}

    private getClient(): Promise<WebClient> {
        this.client ??= (async () => {
            const { WebClient } = await import("@slack/web-api");
            const { botToken } = await this.settings.getCredentials();
            // The SDK's default retries a failed call for up to half an hour. Inside a 3-second
            // ingress or a queue-driven worker that is a hang, not resilience: fail fast and let
            // the queue's own retry decide.
            return new WebClient(botToken, { retryConfig: { retries: 2, maxRetryTime: 5_000 }, timeout: 10_000 });
        })().catch((err) => {
            this.client = undefined;
            throw err;
        });
        return this.client;
    }

    /** Posts in a thread and returns the new message's ts. */
    public async postInThread(channel: string, threadTs: string, message: SlackMessage): Promise<string> {
        const client = await this.getClient();
        const response = await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: message.text,
            blocks: message.blocks,
            unfurl_links: false,
            unfurl_media: false,
        });
        if (!response.ts) throw new Error("Slack accepted the message but returned no timestamp.");
        return response.ts;
    }

    public async update(channel: string, ts: string, message: SlackMessage): Promise<void> {
        const client = await this.getClient();
        await client.chat.update({ channel, ts, text: message.text, blocks: message.blocks });
    }

    /** A message only `user` sees — for notices that are nobody else's business. */
    public async whisper(channel: string, user: string, text: string, threadTs?: string): Promise<void> {
        const client = await this.getClient();
        await client.chat.postEphemeral({ channel, user, text, thread_ts: threadTs });
    }
}
