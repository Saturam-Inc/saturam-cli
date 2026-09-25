import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { resolveAwsClientConfig } from "../utils/aws-credentials.util";

const logger = getLogger("S3Service");

@Service()
export class S3Service {
    private client: import("@aws-sdk/client-s3").S3Client | undefined;

    constructor(private readonly config: ConfigService) {}

    private async getClient(region: string): Promise<import("@aws-sdk/client-s3").S3Client> {
        if (this.client) return this.client;

        const { S3Client } = await import("@aws-sdk/client-s3");
        const cloudConfig = await this.config.getAWSCloudConfig();
        const clientConfig = await resolveAwsClientConfig(cloudConfig);

        this.client = new S3Client({ ...clientConfig, region });
        return this.client;
    }

    /** Constrains a prefix to whole path segments, so it cannot match a longer sibling name. */
    private static asFolderPrefix(prefix?: string): string | undefined {
        if (!prefix) return undefined;
        return prefix.endsWith("/") ? prefix : `${prefix}/`;
    }

    private resolveKey(key: string, prefix?: string): string {
        if (!prefix) return key;
        const normalizedPrefix = prefix.replace(/\/+$/, "");
        return `${normalizedPrefix}/${key.replace(/^\/+/, "")}`;
    }

    /**
     * Fetches an object from the configured S3 bucket (key is relative to the configured prefix, if any).
     */
    public async getObject(key: string): Promise<Buffer> {
        const { bucket, prefix, region } = await this.config.getS3Config();
        return this.fetchObject(bucket, region, this.resolveKey(key, prefix));
    }

    /**
     * Fetches an object from the state prefix rather than the content prefix.
     *
     * The ingestion pipeline keeps registry.json and its run status beside the documents, not
     * among them, so Bedrock does not index state files as documentation. That puts them outside
     * the prefix getObject() resolves against, which is why reading them needs its own method
     * rather than a cleverer key.
     */
    public async getStateObject(key: string): Promise<Buffer> {
        const { bucket, statePrefix, region } = await this.config.getS3Config();
        return this.fetchObject(bucket, region, this.resolveKey(key, statePrefix));
    }

    private async fetchObject(bucket: string, region: string, fullKey: string): Promise<Buffer> {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        const client = await this.getClient(region);

        logger.debug(`Fetching s3://${bucket}/${fullKey}`);

        try {
            const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey }));
            const body = await response.Body?.transformToByteArray();
            if (!body) {
                throw new Error("Empty response body");
            }
            return Buffer.from(body);
        } catch (err) {
            throw new Error(`Failed to get s3://${bucket}/${fullKey}: ${(err as Error).message}`);
        }
    }

    /**
     * Checks whether an object already exists at the given key (relative to the configured prefix, if any).
     */
    public async objectExists(key: string): Promise<boolean> {
        const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
        const { bucket, prefix, region } = await this.config.getS3Config();
        const client = await this.getClient(region);
        const fullKey = this.resolveKey(key, prefix);

        try {
            await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fullKey }));
            return true;
        } catch (err) {
            const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
            const name = (err as { name?: string }).name;
            if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") {
                return false;
            }
            throw new Error(`Failed to check s3://${bucket}/${fullKey}: ${(err as Error).message}`);
        }
    }

    /**
     * Uploads an object to the configured S3 bucket (key is relative to the configured prefix, if any).
     */
    public async putObject(key: string, body: Buffer | string, contentType?: string): Promise<void> {
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        const { bucket, prefix, region } = await this.config.getS3Config();
        const client = await this.getClient(region);
        const fullKey = this.resolveKey(key, prefix);

        logger.debug(`Uploading s3://${bucket}/${fullKey}`);

        try {
            await client.send(
                new PutObjectCommand({ Bucket: bucket, Key: fullKey, Body: body, ContentType: contentType }),
            );
        } catch (err) {
            throw new Error(`Failed to put s3://${bucket}/${fullKey}: ${(err as Error).message}`);
        }
    }

    /**
     * Lists object keys in the configured bucket under an optional sub-prefix
     * (appended to the configured prefix, if any).
     *
     * S3 matches a prefix as a literal string, not as a path, so listing "onboarding" would also
     * return every key under the sibling "onboarding-state/" — the state prefix this same bucket
     * holds alongside the content. The trailing slash is what keeps the two apart.
     */
    public async listObjects(subPrefix?: string): Promise<string[]> {
        const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
        const { bucket, prefix, region } = await this.config.getS3Config();
        const client = await this.getClient(region);
        const effectivePrefix = S3Service.asFolderPrefix(subPrefix ? this.resolveKey(subPrefix, prefix) : prefix);

        try {
            const keys: string[] = [];
            let continuationToken: string | undefined;
            do {
                const response = await client.send(
                    new ListObjectsV2Command({
                        Bucket: bucket,
                        Prefix: effectivePrefix,
                        ContinuationToken: continuationToken,
                    }),
                );
                for (const obj of response.Contents ?? []) {
                    if (obj.Key) keys.push(obj.Key);
                }
                continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (continuationToken);
            return keys;
        } catch (err) {
            throw new Error(`Failed to list s3://${bucket}/${effectivePrefix ?? ""}: ${(err as Error).message}`);
        }
    }
}
