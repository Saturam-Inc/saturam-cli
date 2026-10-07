import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { resolveAwsClientConfig } from "../utils/aws-credentials.util";

const logger = getLogger("BedrockKnowledgeBaseService");

export interface RetrievedChunk {
    content: string;
    score?: number;
    location?: string;
    metadata?: Record<string, unknown>;
}

@Service()
export class BedrockKnowledgeBaseService {
    private client: import("@aws-sdk/client-bedrock-agent-runtime").BedrockAgentRuntimeClient | undefined;
    private clientRegion: string | undefined;

    constructor(private readonly config: ConfigService) {}

    private async getClient(
        region: string,
    ): Promise<import("@aws-sdk/client-bedrock-agent-runtime").BedrockAgentRuntimeClient> {
        // Cached client is only valid for the region it was built with — a Knowledge Base can be
        // configured in a different region from a previous call, so a stale cache would silently
        // keep querying the wrong region instead of honoring the one just requested.
        if (this.client && this.clientRegion === region) return this.client;

        const { BedrockAgentRuntimeClient } = await import("@aws-sdk/client-bedrock-agent-runtime");
        const cloudConfig = await this.config.getAWSCloudConfig();
        const clientConfig = await resolveAwsClientConfig(cloudConfig);

        // A Knowledge Base can be configured in a different region from the
        // default AWS/S3 region, so its explicit region must win here.
        this.client = new BedrockAgentRuntimeClient({ ...clientConfig, region });
        this.clientRegion = region;
        return this.client;
    }

    /**
     * Retrieves the most relevant document chunks from the configured Bedrock Knowledge Base for a query.
     */
    public async retrieve(
        query: string,
        options?: { numberOfResults?: number; project?: string },
    ): Promise<RetrievedChunk[]> {
        const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");
        const { knowledgeBaseId, region } = await this.config.getBedrockKnowledgeBaseConfig();
        const client = await this.getClient(region);

        logger.debug(`Retrieving from Bedrock Knowledge Base ${knowledgeBaseId}: "${query}"`);

        try {
            const response = await client.send(
                new RetrieveCommand({
                    knowledgeBaseId,
                    retrievalQuery: { text: query },
                    retrievalConfiguration:
                        options?.numberOfResults || options?.project
                            ? {
                                  vectorSearchConfiguration: {
                                      numberOfResults: options.numberOfResults,
                                      filter: options.project
                                          ? { equals: { key: "project", value: options.project } }
                                          : undefined,
                                  },
                              }
                            : undefined,
                }),
            );

            return (response.retrievalResults ?? []).map((result) => ({
                content:
                    result.content?.text ??
                    result.content?.row
                        ?.map((column) => `${column.columnName ?? "column"}: ${column.columnValue ?? ""}`)
                        .join("\n") ??
                    "",
                score: result.score,
                location:
                    result.location?.s3Location?.uri ??
                    result.location?.webLocation?.url ??
                    result.location?.confluenceLocation?.url ??
                    result.location?.salesforceLocation?.url ??
                    result.location?.sharePointLocation?.url ??
                    result.location?.customDocumentLocation?.id ??
                    result.location?.kendraDocumentLocation?.uri ??
                    result.location?.sqlLocation?.query,
                metadata: result.metadata as Record<string, unknown> | undefined,
            }));
        } catch (err) {
            throw new Error(
                `Failed to retrieve from Bedrock Knowledge Base ${knowledgeBaseId}: ${(err as Error).message}`,
            );
        }
    }
}
