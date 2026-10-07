import { getLogger } from "log4js";
import { Service } from "typedi";
import { JobQueueProvider } from "./job-queue";
import { SlackGateway } from "./slack-gateway";
import { SlackInbound, parseEventsApiBody, parseInteractionPayload } from "./slack-inbound";
import { MAX_QUESTION_CHARS } from "./slack-jobs";
import {
    AskedQuestion,
    NOT_ENABLED_HERE,
    QUESTION_TOO_LONG,
    USAGE_HINT,
    failureMessage,
    noticeMessage,
    placeholderMessage,
} from "./slack-messages";
import { SlackSettings, isConversationAllowed } from "./slack-settings";
import { verifySlackSignature } from "./slack-signature";
import { SlackStateService } from "./slack-state.service";

const logger = getLogger("SlackIngress");

export interface HttpRequest {
    /** The raw body, exactly as received — the signature is computed over these bytes. */
    body: string;
    /** Header names in lower case. */
    headers: Record<string, string | undefined>;
}

export interface HttpResponse {
    statusCode: number;
    headers?: Record<string, string>;
    body: string;
}

const OK: HttpResponse = { statusCode: 200, body: "" };

type Question = Extract<SlackInbound, { type: "question" }>;

/**
 * The front door: everything that must happen inside Slack's three-second acknowledgement window,
 * and nothing that might not fit in it.
 *
 * It verifies the request, drops Slack's re-deliveries, applies the access policy, posts a
 * "Thinking…" placeholder so the user sees their question was heard, and queues the real work.
 * Answering — a multi-round agent over Bedrock that takes tens of seconds — happens in the worker.
 *
 * Deliberately imports nothing from the answering stack, which keeps the ingress Lambda's cold
 * start small.
 */
@Service()
export class SlackIngressService {
    constructor(
        private readonly settings: SlackSettings,
        private readonly gateway: SlackGateway,
        private readonly state: SlackStateService,
        private readonly queues: JobQueueProvider,
    ) {}

    /** HTTP transport (API Gateway → Lambda). */
    public async handleHttp(request: HttpRequest): Promise<HttpResponse> {
        const { signingSecret } = await this.settings.getCredentials();
        if (!signingSecret) {
            logger.error(
                "No Slack signing secret is configured — refusing every request rather than skipping the check.",
            );
            return { statusCode: 500, body: "" };
        }

        const verified = verifySlackSignature({
            signingSecret,
            body: request.body,
            timestamp: request.headers["x-slack-request-timestamp"],
            signature: request.headers["x-slack-signature"],
        });
        if (!verified) {
            logger.warn("Rejected a request with a missing, stale or invalid Slack signature.");
            return { statusCode: 401, body: "" };
        }

        const retry = request.headers["x-slack-retry-num"];
        if (retry)
            logger.info(`Slack retry #${retry} (${request.headers["x-slack-retry-reason"] ?? "unknown reason"}).`);

        const inbound = this.parseHttp(request);
        if (inbound.type === "url_verification") {
            return {
                statusCode: 200,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ challenge: inbound.challenge }),
            };
        }

        const handled = await this.dispatch(inbound);
        // A failure before anything reached the user is answered with an error so Slack retries
        // it — the delivery was released, so the retry will be handled rather than deduplicated.
        return handled ? OK : { statusCode: 500, body: "" };
    }

    private parseHttp(request: HttpRequest): SlackInbound {
        try {
            const contentType = request.headers["content-type"] ?? "";
            if (contentType.includes("application/x-www-form-urlencoded")) {
                const payload = new URLSearchParams(request.body).get("payload");
                return payload
                    ? parseInteractionPayload(JSON.parse(payload))
                    : { type: "ignored", reason: "form post without an interaction payload" };
            }
            return parseEventsApiBody(JSON.parse(request.body));
        } catch (err) {
            return { type: "ignored", reason: `unparseable body (${(err as Error).message})` };
        }
    }

    /**
     * Acts on one inbound delivery. Shared by the HTTP and Socket Mode transports.
     *
     * @returns false only when handling failed before anything reached the user and a retry of
     *   the same delivery should be attempted.
     */
    public async dispatch(inbound: SlackInbound): Promise<boolean> {
        if (inbound.type === "ignored") {
            logger.debug(`Ignored: ${inbound.reason}`);
            return true;
        }
        if (inbound.type === "url_verification") return true;

        if (!(await this.state.claimDelivery(inbound.dedupeKey))) {
            logger.info(`Already handled ${inbound.dedupeKey} — ignoring the re-delivery.`);
            return true;
        }

        if (!isConversationAllowed(this.settings.get().access, inbound)) {
            logger.info(`Not answering in ${inbound.teamId}/${inbound.channelId}: not on the allow-list.`);
            await this.gateway
                .whisper(inbound.channelId, inbound.userId, NOT_ENABLED_HERE, inbound.threadTs)
                .catch((err) => logger.warn(`Could not send the not-enabled notice: ${(err as Error).message}`));
            return true;
        }

        if (inbound.type === "feedback") {
            try {
                await this.queues.get().enqueue({
                    kind: "feedback",
                    id: inbound.dedupeKey,
                    teamId: inbound.teamId,
                    channelId: inbound.channelId,
                    userId: inbound.userId,
                    threadTs: inbound.threadTs,
                    messageTs: inbound.messageTs,
                    ownerId: inbound.ownerId,
                    sessionId: inbound.sessionId,
                    rating: inbound.rating,
                });
            } catch (err) {
                // Interactions are never retried by Slack, so there is nothing to release for.
                logger.error(`Could not queue feedback ${inbound.dedupeKey}: ${(err as Error).message}`);
            }
            return true;
        }

        return this.acceptQuestion(inbound);
    }

    private async acceptQuestion(question: Question): Promise<boolean> {
        const { channelId, threadTs, userId } = question;

        if (!question.text) {
            await this.gateway
                .postInThread(channelId, threadTs, noticeMessage(USAGE_HINT))
                .catch((err) => logger.warn(`Could not post the usage hint: ${(err as Error).message}`));
            return true;
        }
        if (question.text.length > MAX_QUESTION_CHARS) {
            await this.gateway
                .whisper(channelId, userId, QUESTION_TOO_LONG, threadTs)
                .catch((err) => logger.warn(`Could not send the too-long notice: ${(err as Error).message}`));
            return true;
        }

        const asked: AskedQuestion = { question: question.text, source: question.source, userId };

        let placeholderTs: string;
        try {
            placeholderTs = await this.gateway.postInThread(channelId, threadTs, placeholderMessage(asked));
        } catch (err) {
            logger.error(`Could not post the placeholder for ${question.dedupeKey}: ${(err as Error).message}`);
            await this.state.releaseDelivery(question.dedupeKey);
            return false;
        }

        try {
            await this.queues.get().enqueue({
                kind: "question",
                id: question.dedupeKey,
                teamId: question.teamId,
                channelId,
                userId,
                threadTs,
                question: question.text,
                source: question.source,
                placeholderTs,
            });
            logger.info(`Queued ${question.dedupeKey} (${question.source}) in ${channelId}/${threadTs}.`);
        } catch (err) {
            // The user can already see the placeholder, so tell them there rather than retry into
            // a second placeholder.
            logger.error(`Could not queue ${question.dedupeKey}: ${(err as Error).message}`);
            await this.gateway
                .update(channelId, placeholderTs, failureMessage(asked, question.dedupeKey))
                .catch((updateErr) => logger.warn(`Could not report the failure: ${(updateErr as Error).message}`));
        }
        return true;
    }
}
