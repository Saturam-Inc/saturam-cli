import { readFileSync } from "fs";
import { join } from "path";

const DEPLOY = join(__dirname, "..", "..", "deploy", "slack-bot");

/** The placeholder names the values sheet in docs/SLACK-BOT-AWS-SETUP.md defines. */
const VALUES_SHEET = new Set([
    "REGION",
    "ACCOUNT_ID",
    "BUCKET_NAME",
    "CONTENT_PREFIX",
    "STATE_PREFIX",
    "KNOWLEDGE_BASE_ID",
    "TABLE_NAME",
    "SECRET_NAME",
    "QUEUE_NAME",
    "MODEL_ID",
    "PROFILE_PREFIX",
    "API_GATEWAY_URL",
]);

const AWS_ACCOUNT_ID = /\b\d{12}\b/;
const AWS_REGION = /\b(?:us|eu|ap|sa|ca|me|af|il)-[a-z]+-\d\b/;

function read(file: string): string {
    return readFileSync(join(DEPLOY, file), "utf8");
}

function placeholdersIn(text: string): string[] {
    return [...text.matchAll(/<([A-Z_]+)>/g)].map((match) => match[1]);
}

/**
 * The deploy assets are templates, filled in outside the repository (docs B6: `*.local.json`).
 * Once they were committed with a real account ID, knowledge base ID and bucket in them; these
 * checks make that a failing test rather than something a reviewer has to notice.
 */
describe("Slack bot deploy templates", () => {
    describe.each(["iam/worker-policy.json", "iam/ingress-policy.json"])("%s", (file) => {
        const text = read(file);

        it("is valid JSON", () => {
            expect(() => JSON.parse(text)).not.toThrow();
        });

        it("names no real account or region", () => {
            expect(text).not.toMatch(AWS_ACCOUNT_ID);
            expect(text).not.toMatch(AWS_REGION);
        });

        it("uses <REGION> and <ACCOUNT_ID> in every regional ARN", () => {
            const policy = JSON.parse(text) as { Statement: Array<{ Resource: string | string[] }> };
            const arns = policy.Statement.flatMap((statement) => [statement.Resource].flat());
            for (const arn of arns) {
                const [, , service, region, account] = arn.split(":");
                if (service === "s3") continue; // S3 ARNs carry neither
                if (region === "*" || region === "") continue; // regionless / any-region model ARNs
                expect({ arn, region, account }).toEqual({ arn, region: "<REGION>", account: "<ACCOUNT_ID>" });
            }
        });
    });

    it.each(["iam/worker-policy.json", "iam/ingress-policy.json", "lambda-env.example", "slack-app-manifest.yaml"])(
        "%s uses only placeholders the values sheet defines",
        (file) => {
            const unknown = placeholdersIn(read(file)).filter((name) => !VALUES_SHEET.has(name));
            expect(unknown).toEqual([]);
        },
    );

    it("lambda-env.example carries no real account, region or invoke URL", () => {
        const text = read("lambda-env.example");
        expect(text).not.toMatch(AWS_ACCOUNT_ID);
        expect(text).not.toMatch(AWS_REGION);
        expect(text).not.toMatch(/execute-api/);
    });

    it("the Slack manifest has no real request URL", () => {
        expect(read("slack-app-manifest.yaml")).not.toMatch(/https?:\/\/[^<\s]+\/slack\/events/);
    });
});
