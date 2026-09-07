import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "./config-service";

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

function normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, "");
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

        const url = `${normalizeBaseUrl(remote.url)}${CREDENTIALS_PATH}`;
        const headers: Record<string, string> = { Accept: "application/json" };
        // The token is optional: only send it when configured.
        if (remote.token) {
            headers.Authorization = `Bearer ${remote.token}`;
        }

        logger.debug(`Requesting AWS credentials from ${url}`);

        let response: Response;
        try {
            response = await fetch(url, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            throw new Error(`Failed to reach remote credential endpoint at ${url}: ${getErrorMessage(error)}`);
        }

        if (!response.ok) {
            throw new Error(`Remote credential endpoint returned HTTP ${response.status} from ${url}.`);
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            throw new Error(`Remote credential endpoint returned an invalid JSON response from ${url}.`);
        }

        return parseCredentials(payload);
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseCredentials(payload: unknown): AwsCredentials {
    if (!payload || typeof payload !== "object") {
        throw new Error("Remote credential response was not a valid object.");
    }

    const data = payload as Record<string, unknown>;
    const accessKeyId = pickString(data, ["accessKeyId", "AccessKeyId"]);
    const secretAccessKey = pickString(data, ["secretAccessKey", "SecretAccessKey"]);
    const sessionToken = pickString(data, ["sessionToken", "SessionToken"]);
    const expirationRaw = pickString(data, ["expiration", "Expiration"]);

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Remote credential response is missing accessKeyId or secretAccessKey.");
    }

    const credentials: AwsCredentials = { accessKeyId, secretAccessKey };
    if (sessionToken) credentials.sessionToken = sessionToken;
    if (expirationRaw) {
        const expiration = new Date(expirationRaw);
        if (!isNaN(expiration.getTime())) credentials.expiration = expiration;
    }

    return credentials;
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
}
