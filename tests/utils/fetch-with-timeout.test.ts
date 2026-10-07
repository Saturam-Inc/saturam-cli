import { getLogger } from "log4js";
import { fetchWithTimeout } from "../../src/utils/fetch-with-timeout";

// Built inside the factory: the module under test calls getLogger() as it loads, which is before
// any top-level const here would be initialised.
jest.mock("log4js", () => {
    const logger = { warn: jest.fn(), debug: jest.fn() };
    return { getLogger: () => logger };
});
const mockLogger = getLogger("FetchWithTimeout") as unknown as { warn: jest.Mock; debug: jest.Mock };

// Helper to create a mock response
function makeMockResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(body)),
        text: () => Promise.resolve(body),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
        blob: () => Promise.resolve(new Blob([body])),
        clone: jest.fn(),
        body: null,
        bodyUsed: false,
        redirected: false,
        type: "basic" as any,
        url: "",
        formData: () => Promise.reject(new Error("not implemented")),
    } as unknown as Response;
}

describe("fetchWithTimeout", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger.warn.mockClear();
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.useRealTimers();
    });

    it("should return a response when fetch succeeds within the timeout", async () => {
        global.fetch = jest.fn().mockResolvedValue(makeMockResponse(JSON.stringify({ ok: true })));

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        // advance timers so the fetch mock resolves
        jest.advanceTimersByTime(100);
        const response = await responsePromise;
        expect(response).toBeDefined();
        expect(response.ok).toBe(true);
    });

    it("should call fetch with the AbortController signal attached", async () => {
        const mockFetch = jest.fn().mockResolvedValue(makeMockResponse("{}"));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api");
        jest.advanceTimersByTime(100);
        await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callInit = mockFetch.mock.calls[0][1];
        expect(callInit.signal).toBeInstanceOf(AbortSignal);
    });

    it("should throw a timeout error when AbortController fires", async () => {
        global.fetch = jest.fn().mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    (init.signal as AbortSignal).addEventListener("abort", () => {
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        reject(err);
                    });
                }),
        );

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 1000);
        jest.advanceTimersByTime(1001);
        await expect(responsePromise).rejects.toThrow("timed out after 1000ms");
    });

    it("should re-throw non-abort errors", async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        jest.advanceTimersByTime(100);
        await expect(responsePromise).rejects.toThrow("Network error");
    });

    it("resolves a .json() body read that finishes before the timeout", async () => {
        let resolveJson!: () => void;
        const slowJsonPromise = new Promise<any>((_resolve) => {
            resolveJson = () => _resolve({ data: "late" });
        });

        const mockResponse = {
            ...makeMockResponse("{}"),
            json: () => slowJsonPromise,
        } as unknown as Response;

        global.fetch = jest.fn().mockResolvedValue(mockResponse);

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 500);
        jest.advanceTimersByTime(50);
        const response = await responsePromise;

        const jsonPromise = response.json();
        resolveJson();
        const result = await jsonPromise;
        expect(result).toEqual({ data: "late" });
    });

    it("actually aborts a stalled .json() body read once the timeout elapses, rejecting with a body-read timeout error", async () => {
        // A real fetch implementation aborts the in-flight body read when the request's
        // AbortSignal fires — simulate that here by having the mocked .json() listen for abort,
        // to prove the timer that's kept alive during the body read really does abort it.
        let capturedSignal!: AbortSignal;
        const mockFetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
            capturedSignal = init.signal as AbortSignal;
            return Promise.resolve({
                ...makeMockResponse("{}"),
                json: () =>
                    new Promise((_resolve, reject) => {
                        capturedSignal.addEventListener("abort", () => {
                            const err = new Error("The operation was aborted");
                            err.name = "AbortError";
                            reject(err);
                        });
                    }),
            });
        });
        global.fetch = mockFetch as any;

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 500);
        jest.advanceTimersByTime(50);
        const response = await responsePromise;

        const jsonPromise = response.json();
        // Advance past the 500ms timeout — the body read is still pending, so this must abort it.
        jest.advanceTimersByTime(500);

        await expect(jsonPromise).rejects.toThrow("timed out after 500ms (during body read)");
    });

    it("should retry a 429 response with backoff and return the eventual success", async () => {
        const mockFetch = jest
            .fn()
            .mockResolvedValueOnce(makeMockResponse("rate limited", 429))
            .mockResolvedValueOnce(makeMockResponse(JSON.stringify({ ok: true }), 200));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        await jest.advanceTimersByTimeAsync(5000);
        const response = await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
    });

    it("should honor a Retry-After header when retrying", async () => {
        const rateLimited = makeMockResponse("rate limited", 429);
        (rateLimited.headers as Headers).set("retry-after", "2");
        const mockFetch = jest
            .fn()
            .mockResolvedValueOnce(rateLimited)
            .mockResolvedValueOnce(makeMockResponse("{}", 200));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        await jest.advanceTimersByTimeAsync(2000);
        const response = await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
    });

    it("caps a large Retry-After so a server cannot stall the CLI for as long as it likes", async () => {
        const rateLimited = makeMockResponse("rate limited", 429);
        (rateLimited.headers as Headers).set("retry-after", "3600");
        const mockFetch = jest
            .fn()
            .mockResolvedValueOnce(rateLimited)
            .mockResolvedValueOnce(makeMockResponse("{}", 200));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        await jest.advanceTimersByTimeAsync(29_999);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        const response = await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
    });

    it("caps a Retry-After HTTP date far in the future", async () => {
        const rateLimited = makeMockResponse("rate limited", 429);
        (rateLimited.headers as Headers).set("retry-after", new Date(Date.now() + 3_600_000).toUTCString());
        const mockFetch = jest
            .fn()
            .mockResolvedValueOnce(rateLimited)
            .mockResolvedValueOnce(makeMockResponse("{}", 200));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        await jest.advanceTimersByTimeAsync(30_000);
        const response = await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
    });

    it("warns when a retry waits long enough to be noticed, and says the wait was capped", async () => {
        const rateLimited = makeMockResponse("rate limited", 429);
        (rateLimited.headers as Headers).set("retry-after", "3600");
        global.fetch = jest.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(makeMockResponse("{}", 200));

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        await jest.advanceTimersByTimeAsync(30_000);
        await responsePromise;

        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn.mock.calls[0][0]).toMatch(/HTTP 429 from https:\/\/example\.com\/api/);
        expect(mockLogger.warn.mock.calls[0][0]).toMatch(/retrying in 30000ms .*server asked for 3600000ms, capped/);
    });

    it("logs a short backoff at debug only, so routine retries stay quiet", async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce(makeMockResponse("server error", 503))
            .mockResolvedValueOnce(makeMockResponse("{}", 200));

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        await jest.advanceTimersByTimeAsync(500);
        await responsePromise;

        expect(mockLogger.warn).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("retrying in 500ms (retry 1 of 3)"));
    });

    it("should give up and return the last response after maxRetries persistent 5xx errors", async () => {
        const mockFetch = jest.fn().mockResolvedValue(makeMockResponse("server error", 503));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000, 2);
        await jest.advanceTimersByTimeAsync(10_000);
        const response = await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
        expect(response.status).toBe(503);
    });

    it("should pass request init options to fetch", async () => {
        const mockFetch = jest.fn().mockResolvedValue(makeMockResponse("{}"));
        global.fetch = mockFetch;

        const init: RequestInit = { method: "POST", headers: { Authorization: "Bearer token" } };
        const responsePromise = fetchWithTimeout("https://example.com/api", init);
        jest.advanceTimersByTime(100);
        await responsePromise;

        const callInit = mockFetch.mock.calls[0][1];
        expect(callInit.method).toBe("POST");
        expect((callInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer token");
    });
});
