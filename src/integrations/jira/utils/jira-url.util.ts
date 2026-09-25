/**
 * Utility functions for parsing Jira issue URLs into structured parts.
 * Mirrors the github-url.util.ts pattern used by the SCM integrations.
 */

export interface ParsedJiraUrl {
    baseUrl: string;
    ticketKey: string;
}

/**
 * Extracts `baseUrl` and `ticketKey` from a Jira issue URL.
 *
 * Supports:
 *   - /browse/<KEY-123>    (Cloud & Server browse URL)
 *   - /issues/<KEY-123>   (alternative path form)
 *
 * Returns `null` if the URL cannot be parsed or does not contain a ticket key.
 */
export function parseJiraUrl(urlStr: string): ParsedJiraUrl | null {
    try {
        const url = new URL(urlStr);
        // A Server/Data Center instance is often mounted under a context path (e.g.
        // https://company.com/jira/...) — url.origin alone would drop it, so keep everything
        // before the recognized Jira path segment as part of the base URL.
        const contextPrefix = url.pathname.split(/\/(?:browse|issues)\//)[0];
        const baseUrl = `${url.origin}${contextPrefix}`;

        const browseMatch = url.pathname.match(/\/browse\/([A-Z0-9]+-\d+)/i);
        if (browseMatch) {
            return { baseUrl, ticketKey: browseMatch[1].toUpperCase() };
        }
        const issuesMatch = url.pathname.match(/\/issues\/([A-Z0-9]+-\d+)/i);
        if (issuesMatch) {
            return { baseUrl, ticketKey: issuesMatch[1].toUpperCase() };
        }
        return null;
    } catch {
        return null;
    }
}
