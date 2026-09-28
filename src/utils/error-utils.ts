export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
        return `${error.message}${cause}`;
    }
    return String(error);
}
