import "reflect-metadata";
import { AnswerFlowService } from "../../src/services/knowledge/answer-flow.service";
import { getSlackContainer } from "../../src/slack/slack-container";
import { SlackIngressService } from "../../src/slack/slack-ingress.service";
import { SlackWorkerService } from "../../src/slack/slack-worker.service";

/**
 * The services are wired by typedi from TypeScript's emitted constructor metadata. A build that
 * loses that metadata (most bundlers do) resolves every dependency as undefined and fails only at
 * runtime, on the first message. This catches it at test time.
 */
describe("Slack container", () => {
    it("builds the ingress and worker with all their dependencies", () => {
        const container = getSlackContainer();
        const ingress: any = container.get(SlackIngressService);
        const worker: any = container.get(SlackWorkerService);

        expect(ingress).toBeInstanceOf(SlackIngressService);
        for (const dependency of ["settings", "gateway", "state", "queues"]) {
            expect(ingress[dependency]).toBeDefined();
        }
        expect(worker.answerFlow).toBeInstanceOf(AnswerFlowService);
        expect(worker.gateway).toBe(ingress.gateway);
    });

    it("is built once per process, so warm invocations reuse clients and caches", () => {
        expect(getSlackContainer()).toBe(getSlackContainer());
    });
});
