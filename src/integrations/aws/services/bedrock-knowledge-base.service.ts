import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { RetrievalFilters } from "../../../services/knowledge/knowledge-source.model";
import { resolveAwsClientConfig } from "../utils/aws-credentials.util";

const logger = getLogger("BedrockKnowledgeBaseService");

export interface RetrievedChunk {
    content: string;
    score?: number;
    location?: string;
    metadata?: Record<string, unknown>;
}

export interface RetrieveOptions extends RetrievalFilters {
    numberOfResults?: number;
}

/** The Retrieve API's filter grammar, as far as this service composes it. */
type RetrievalFilter =
    | { equals: { key: string; value: string } }
    | { notEquals: { key: string; value: string } }
    | { andAll: RetrievalFilter[] };

/**
 * Composes the metadata filter for a retrieval, or undefined when nothing narrows it.
 *
 * One condition is sent bare; two or more go under `andAll`, which the API refuses with fewer
 * than two members — the reason this is not simply always a conjunction.
 */
export function buildRetrievalFilter(filters: RetrievalFilters): RetrievalFilter | undefined {
    const conditions: RetrievalFilter[] = [];
    if (filters.project) conditions.push({ equals: { key: "project", value: filters.project } });
    if (filters.category) conditions.push({ equals: { key: "category", value: filters.category } });
    if (filters.excludeCategory) conditions.push({ notEquals: { key: "category", value: filters.excludeCategory } });
    if (filters.repo) conditions.push({ equals: { key: "repo", value: filters.repo } });

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return { andAll: conditions };
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
     *
     * The filters are exact matches on the metadata sidecars the ingestion pipeline writes, ANDed
     * together. The search type is a deployment setting rather than an argument: hybrid search
     * needs a vector store that supports it, and sending it to one that does not fails every
     * query, so it is only ever set by whoever configured the store.
     */
    public async retrieve(query: string, options?: RetrieveOptions): Promise<RetrievedChunk[]> {
        const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");
        const { knowledgeBaseId, region, searchType } = await this.config.getBedrockKnowledgeBaseConfig();
        const client = await this.getClient(region);

        const filter = options ? buildRetrievalFilter(options) : undefined;
        const configured = options?.numberOfResults !== undefined || filter !== undefined || searchType !== undefined;

        logger.debug(`Retrieving from Bedrock Knowledge Base ${knowledgeBaseId}: "${query}"`);

        try {
            const response = await client.send(
                new RetrieveCommand({
                    knowledgeBaseId,
                    retrievalQuery: { text: query },
                    retrievalConfiguration: configured
                        ? {
                              vectorSearchConfiguration: {
                                  numberOfResults: options?.numberOfResults,
                                  filter,
                                  overrideSearchType: searchType,
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
