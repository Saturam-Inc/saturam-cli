/**
 * Normalizes a base URL by removing any trailing slashes.
 */
export function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}

/**
 * Validates if a given string is a valid HTTP or HTTPS URL.
 */
export function isValidHttpUrl(urlString: string): boolean {
    try {
        const url = new URL(urlString);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}
