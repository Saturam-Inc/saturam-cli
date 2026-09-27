import "reflect-metadata";

import { getLogger } from "log4js";
import { SlackIngressService } from "../slack/slack-ingress.service";
import { getSlackContainer } from "../slack/slack-container";
import { prepareLambdaEnvironment } from "../slack/lambda-runtime";
import { configureServiceLogging } from "../utils/logging-utils";

prepareLambdaEnvironment();
configureServiceLogging();
const logger = getLogger("SlackIngressLambda");

/** The parts of an API Gateway HTTP API (payload format 2.0) event this handler reads. */
interface HttpApiEvent {
    body?: string;
    isBase64Encoded?: boolean;
    headers?: Record<string, string | undefined>;
}

interface HttpApiResult {
    statusCode: number;
    headers?: Record<string, string>;
    body: string;
}

/**
 * Slack → API Gateway (HTTP API) → here. Acknowledges within Slack's three-second window and hands
 * questions to the worker through SQS. Configured as the Slack app's Event Subscriptions Request
 * URL and its Interactivity Request URL (the same URL serves both).
 */
export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    const headers = Object.fromEntries(
        Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );

    try {
        return await getSlackContainer().get(SlackIngressService).handleHttp({ body, headers });
    } catch (err) {
        logger.error(`Unhandled ingress error: ${(err as Error).stack ?? err}`);
        return { statusCode: 500, body: "" };
    }
}
