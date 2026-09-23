import { getLogger } from "log4js";
import { Service } from "typedi";
import { normalizeBaseUrl } from "../utils/url-utils";
import { ConfigService, isLoopbackHostname } from "./config-service";

const logger = getLogger("RemoteCredentialService");

const CREDENTIALS_PATH = "/credentials";
const REQUEST_TIMEOUT_MS = 15000;

/** AWS credentials returned by the remote endpoint and consumed by the AWS SDK. */
export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiration?: Date;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches AWS credentials from a remote endpoint (API Gateway -> Lambda ->
 * Secrets Manager). Used when remote mode is configured so developers do not
 * need local AWS credentials. The endpoint does not use Bedrock; it only
 * returns credentials.
 */
@Service()
export class RemoteCredentialService {
    constructor(private readonly config: ConfigService) {}

    /**
     * Retrieves AWS credentials from the configured remote endpoint.
     * @throws Error when remote mode is not configured or the request fails.
     */
    public async getCredentials(): Promise<AwsCredentials> {
        const remote = await this.config.getRemoteConfig();
        if (!remote) {
            throw new Error("Remote mode is not configured. Run 'sat-cli init' to set up a remote URL.");
        }
        return this.fetchFromEndpoint(remote.url, remote.token);
    }

    /**
     * Probes connectivity and authentication against a candidate remote endpoint URL and token.
     */
    public async probeCredentials(url: string, token?: string): Promise<{ success: boolean; message: string }> {
        try {
            await this.fetchFromEndpoint(url, token, 10000, 0);
            const sanitizedBase = normalizeBaseUrl(url);
            return { success: true, message: `Successfully authenticated with ${sanitizedBase}${CREDENTIALS_PATH}` };
        } catch (error) {
            return { success: false, message: getErrorMessage(error) };
        }
    }

    /**
     * Internal implementation to fetch and parse credentials from a remote URL.
     */
    public async fetchFromEndpoint(
        rawUrl: string,
        token?: string,
        timeoutMs: number = REQUEST_TIMEOUT_MS,
        maxRetries: number = 2,
    ): Promise<AwsCredentials> {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(rawUrl);
        } catch {
            throw new Error(`Invalid remote credential URL: "${rawUrl}". Must be a valid URL.`);
        }

        if (parsedUrl.username || parsedUrl.password) {
            throw new Error("Remote credential URL must not include embedded credentials (userinfo).");
        }

        const isLoopback = isLoopbackHostname(parsedUrl.hostname);
        if (parsedUrl.protocol === "http:") {
            if (!isLoopback) {
                throw new Error(
                    `Insecure remote URL "${parsedUrl.origin}". Plain HTTP is only allowed for loopback addresses (localhost/127.0.0.1).`,
                );
            }
        } else if (parsedUrl.protocol !== "https:") {
            throw new Error(
                `Unsupported protocol "${parsedUrl.protocol}" for remote URL. Must use HTTPS or HTTP (loopback only).`,
            );
        }

        const sanitizedBase = normalizeBaseUrl(`${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`);
        const url = `${sanitizedBase}${CREDENTIALS_PATH}`;

        if (!isLoopback && (!token || !token.trim())) {
            throw new Error(
                `Remote credential endpoint "${sanitizedBase}" requires an authentication token. Set SAT_REMOTE_TOKEN or run 'sat-cli init'.`,
            );
        }

        const headers: Record<string, string> = { Accept: "application/json" };
        if (token && token.trim()) {
            headers.Authorization = `Bearer ${token.trim()}`;
        }

        logger.debug(`Requesting AWS credentials from ${url}`);

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const backoffMs = Math.min(1000, 150 * Math.pow(2, attempt) + Math.random() * 100);
                await sleep(backoffMs);
                logger.debug(`Retrying credential request (attempt ${attempt + 1}/${maxRetries + 1}) to ${url}`);
            }

            let response: Response;
            try {
                response = await fetch(url, {
                    method: "GET",
                    headers,
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                lastError = new Error(`Failed to reach remote credential endpoint at ${url}: ${getErrorMessage(error)}`);
                continue;
            }

            if (response.ok) {
                let payload: unknown;
                try {
                    payload = await response.json();
                } catch {
                    throw new Error(`Remote credential endpoint returned an invalid JSON response from ${url}.`);
                }
                return parseCredentials(payload);
            }

            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    `Authentication failed (HTTP ${response.status}) from ${url}. Please check your remote token (SAT_REMOTE_TOKEN or 'sat-cli init').`,
                );
            }

            if (response.status === 404) {
                throw new Error(`Remote credential endpoint not found (HTTP 404) at ${url}.`);
            }

            if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
                lastError = new Error(`Remote credential endpoint returned HTTP ${response.status} from ${url}.`);
                continue;
            }

            throw new Error(`Remote credential endpoint returned HTTP ${response.status} from ${url}.`);
        }

        throw lastError ?? new Error(`Failed to obtain credentials from ${url} after ${maxRetries + 1} attempts.`);
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseCredentials(payload: unknown): AwsCredentials {
    if (!payload || typeof payload !== "object") {
        throw new Error("Remote credential response was not a valid object.");
    }

    const raw = payload as Record<string, unknown>;
    if (raw["Credentials"] !== undefined && raw["Credentials"] !== null && Array.isArray(raw["Credentials"])) {
        throw new Error("Remote credential response contains an invalid Credentials payload (expected object, received array).");
    }
    const data = (raw["Credentials"] && typeof raw["Credentials"] === "object" && !Array.isArray(raw["Credentials"])
        ? raw["Credentials"]
        : raw) as Record<string, unknown>;

    const accessKeyId = pickString(data, ["accessKeyId", "AccessKeyId"]);
    const secretAccessKey = pickString(data, ["secretAccessKey", "SecretAccessKey"]);
    const sessionToken = pickString(data, ["sessionToken", "SessionToken"]);
    const expirationVal = data["expiration"] ?? data["Expiration"];

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Remote credential response is missing accessKeyId or secretAccessKey.");
    }

    let expirationDate: Date | undefined;
    if (expirationVal !== undefined && expirationVal !== null) {
        if (typeof expirationVal === "number") {
            expirationDate = new Date(expirationVal > 1e11 ? expirationVal : expirationVal * 1000);
        } else if (typeof expirationVal === "string" && expirationVal.trim().length > 0) {
            if (/^\d+$/.test(expirationVal.trim())) {
                const num = Number(expirationVal.trim());
                expirationDate = new Date(num > 1e11 ? num : num * 1000);
            } else {
                expirationDate = new Date(expirationVal);
            }
        } else if (expirationVal instanceof Date) {
            expirationDate = expirationVal;
        }

        if (!expirationDate || isNaN(expirationDate.getTime())) {
            throw new Error("Remote credential response contains an invalid expiration timestamp.");
        }
    }

    const isTemporaryCreds = accessKeyId.startsWith("ASIA") || !!expirationDate;
    if (isTemporaryCreds && !sessionToken) {
        throw new Error("Remote credential response returned temporary credentials without a required sessionToken.");
    }

    const credentials: AwsCredentials = { accessKeyId, secretAccessKey };
    if (sessionToken) credentials.sessionToken = sessionToken;
    if (expirationDate) credentials.expiration = expirationDate;

    return credentials;
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
}
