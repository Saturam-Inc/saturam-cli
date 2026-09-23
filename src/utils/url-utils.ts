/**
 * Normalizes a base URL by removing any trailing slashes.
 */
export function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}
