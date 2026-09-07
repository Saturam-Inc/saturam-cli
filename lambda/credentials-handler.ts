import {
    GetSecretValueCommand,
    SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * Lambda that returns AWS credentials to SAT-CLI.
 *
 * Flow: API Gateway -> this Lambda -> AWS Secrets Manager -> credentials -> SAT-CLI.
 *
 * This function ONLY reads a secret from Secrets Manager and returns it. It does
 * not call AWS Bedrock or any other AI service — Bedrock is invoked by SAT-CLI
 * using the credentials returned here.
 *
 * Configuration (environment variables):
 *   SECRET_ID    - name/ARN of the Secrets Manager secret holding AWS credentials (required)
 *   EXPECTED_TOKEN - optional shared token. When set, requests must send a matching
 *                    `Authorization: Bearer <token>` header. When unset, no token is required.
 */

// Minimal shapes so this handler stays independent of the aws-lambda types package.
interface ApiGatewayEvent {
    headers?: Record<string, string | undefined> | null;
}

interface ApiGatewayResult {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

interface StoredCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiration?: string;
}

const secretsManager = new SecretsManagerClient({});

function jsonResponse(statusCode: number, body: unknown): ApiGatewayResult {
    return {
        statusCode,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

/** Reads the bearer token from the request headers, if present (case-insensitive). */
function getBearerToken(headers?: Record<string, string | undefined> | null): string | undefined {
    if (!headers) return undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === "authorization" && typeof value === "string") {
            const match = /^Bearer\s+(.+)$/i.exec(value.trim());
            return match ? match[1] : undefined;
        }
    }
    return undefined;
}

function parseStoredCredentials(secretString: string): StoredCredentials {
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(secretString) as Record<string, unknown>;
    } catch {
        throw new Error("Secret value is not valid JSON.");
    }

    const accessKeyId = pickString(data, ["accessKeyId", "AccessKeyId", "aws_access_key_id"]);
    const secretAccessKey = pickString(data, ["secretAccessKey", "SecretAccessKey", "aws_secret_access_key"]);
    const sessionToken = pickString(data, ["sessionToken", "SessionToken", "aws_session_token"]);
    const expiration = pickString(data, ["expiration", "Expiration"]);

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Secret is missing accessKeyId or secretAccessKey.");
    }

    const credentials: StoredCredentials = { accessKeyId, secretAccessKey };
    if (sessionToken) credentials.sessionToken = sessionToken;
    if (expiration) credentials.expiration = expiration;
    return credentials;
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResult> {
    const secretId = process.env.SECRET_ID;
    if (!secretId) {
        return jsonResponse(500, { error: "Server misconfiguration: SECRET_ID is not set." });
    }

    // Optional token check: only enforced when EXPECTED_TOKEN is configured.
    const expectedToken = process.env.EXPECTED_TOKEN;
    if (expectedToken) {
        const provided = getBearerToken(event.headers);
        if (provided !== expectedToken) {
            return jsonResponse(401, { error: "Unauthorized." });
        }
    }

    let secretString: string | undefined;
    try {
        const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
        secretString = result.SecretString;
    } catch (error) {
        return jsonResponse(502, {
            error: `Failed to read secret: ${error instanceof Error ? error.message : String(error)}`,
        });
    }

    if (!secretString) {
        return jsonResponse(502, { error: "Secret has no string value." });
    }

    try {
        const credentials = parseStoredCredentials(secretString);
        return jsonResponse(200, credentials);
    } catch (error) {
        return jsonResponse(500, {
            error: error instanceof Error ? error.message : "Failed to parse stored credentials.",
        });
    }
}
