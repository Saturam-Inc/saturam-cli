/**
 * Utility functions for parsing Confluence page URLs into structured parts.
 * Mirrors the github-url.util.ts pattern used by the SCM integrations.
 */

export interface ParsedConfluenceUrl {
    baseUrl: string;
    pageId: string;
}

/**
 * Extracts `baseUrl` and `pageId` from a Confluence page URL.
 *
 * Supports:
 *   - /wiki/spaces/<KEY>/pages/<id>   (Cloud & Server)
 *   - ?pageId=<id>                    (legacy query-param style)
 *   - /pages/<id>                     (short generic form)
 *
 * Returns `null` if the URL cannot be parsed or does not contain a page ID.
 */
export function parseConfluenceUrl(urlStr: string): ParsedConfluenceUrl | null {
    try {
        const url = new URL(urlStr);
        // A Server/Data Center instance is often mounted under a context path (e.g.
        // https://company.com/confluence/...) — url.origin alone would drop it, so keep
        // everything before the recognized Confluence path segment as part of the base URL.
        const contextPrefix = url.pathname.split(/\/(?:wiki\/spaces|pages)\//)[0];
        const baseUrl = `${url.origin}${contextPrefix}`;

        const spacePageMatch = url.pathname.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/i);
        if (spacePageMatch) {
            return { baseUrl, pageId: spacePageMatch[1] };
        }
        const pageIdQuery = url.searchParams.get("pageId");
        if (pageIdQuery) {
            return { baseUrl, pageId: pageIdQuery };
        }
        const generalPageMatch = url.pathname.match(/\/pages\/(\d+)/i);
        if (generalPageMatch) {
            return { baseUrl, pageId: generalPageMatch[1] };
        }
        return null;
    } catch {
        return null;
    }
}
