import { URL } from "url";

/**
 * Normalizes a base URL by removing any trailing slashes.
 * @param baseUrl - Raw base URL string
 * @returns Cleaned base URL without trailing slashes
 */
export function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Sanitizes a URL string by trimming whitespace and normalizing trailing slashes.
 * @param url - Raw URL string
 * @returns Sanitized URL string
 */
export function sanitizeUrl(url: string): string {
    return normalizeBaseUrl(url);
}

/**
 * Checks whether a given string is a valid HTTP or HTTPS URL.
 * @param url - URL string to check
 * @returns True if valid HTTP/HTTPS URL, false otherwise
 */
export function isValidHttpUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Checks if a URL contains a specific query parameter.
 * @param url - Complete URL string
 * @param param - Query parameter key to look for
 * @returns True if parameter exists in query string
 */
export function hasQueryParam(url: string, param: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.searchParams.has(param);
    } catch {
        return false;
    }
}

/**
 * Strips query parameters and hash fragments from a URL.
 * @param url - Raw URL string
 * @returns Endpoint path without query parameters or hash fragments
 */
export function stripQueryAndHash(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url.split("?")[0].split("#")[0];
    }
}

