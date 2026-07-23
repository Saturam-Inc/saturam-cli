/**
 * Confluence REST API path segment (excluding the /wiki prefix).
 * getApiBase() in ConfluenceService appends /wiki for Atlassian Cloud instances,
 * then appends this path to form the full API base.
 * Final URL example: https://example.atlassian.net/wiki/rest/api
 */
export const CONFLUENCE_API_PATH = "/rest/api";
