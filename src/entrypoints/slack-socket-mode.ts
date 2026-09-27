import "dotenv/config";
import "reflect-metadata";

import { getLogger } from "log4js";
import { JobQueueProvider } from "../slack/job-queue";
import { loadLlmCredentials } from "../slack/lambda-runtime";
import { getSlackContainer } from "../slack/slack-container";
import { parseEventsApiBody, parseInteractionPayload } from "../slack/slack-inbound";
import { SlackIngressService } from "../slack/slack-ingress.service";
import { SLACK_ENV } from "../slack/slack-settings";
import { SlackWorkerService } from "../slack/slack-worker.service";
import { configureServiceLogging } from "../utils/logging-utils";

configureServiceLogging(process.env.LOG_LEVEL ?? "debug");
const logger = getLogger("SlackSocketMode");

/**
 * Runs the whole bot on a developer machine over Socket Mode: no public URL, no API Gateway,
 * no queue. Slack pushes events down a WebSocket, and questions are answered in this process
 * by the same ingress and worker services the Lambdas run.
 *
 *   pnpm slack:dev
 *
 * Needs SLACK_APP_TOKEN (xapp-…, with connections:write) and SLACK_BOT_TOKEN (xoxb-…), plus the
 * SATENG_* knowledge base settings or an existing `sat-cli init` config. See
 * docs/SLACK-BOT.md, "Local development".
 */
async function main(): Promise<void> {
    const appToken = process.env[SLACK_ENV.APP_TOKEN];
    if (!appToken) throw new Error(`${SLACK_ENV.APP_TOKEN} (xapp-…) is required for Socket Mode.`);

    // Optional locally: .env values work too, but this lets a developer use the deployed secret.
    await loadLlmCredentials();

    const container = getSlackContainer();
    const ingress = container.get(SlackIngressService);
    const worker = container.get(SlackWorkerService);
    container.get(JobQueueProvider).runInProcess((job) => worker.process(job));

    const { SocketModeClient } = await import("@slack/socket-mode");
    const client = new SocketModeClient({ appToken });

    client.on("slack_event", async ({ ack, type, body }: { ack: () => Promise<void>; type: string; body: unknown }) => {
        // Acknowledge first, as the HTTP ingress does by returning: Slack's clock is the same.
        await ack();
        const inbound =
            type === "events_api"
                ? parseEventsApiBody(body)
                : type === "interactive"
                  ? parseInteractionPayload(body)
                  : ({ type: "ignored", reason: `socket message ${type}` } as const);
        try {
            await ingress.dispatch(inbound);
        } catch (err) {
            logger.error(`Dispatch failed: ${(err as Error).stack ?? err}`);
        }
    });

    await client.start();
    logger.info("Connected to Slack over Socket Mode. Mention the bot or DM it; Ctrl+C to stop.");
}

main().catch((err) => {
    logger.error((err as Error).stack ?? String(err));
    process.exit(1);
});
