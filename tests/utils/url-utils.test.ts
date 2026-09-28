import { isValidHttpUrl, normalizeBaseUrl } from "../../src/utils/url-utils";

describe("url-utils", () => {
    it("normalizes base URLs by stripping trailing slashes", () => {
        expect(normalizeBaseUrl("https://api.saturam.com/")).toBe("https://api.saturam.com");
        expect(normalizeBaseUrl("https://api.saturam.com///")).toBe("https://api.saturam.com");
        expect(normalizeBaseUrl("https://api.saturam.com")).toBe("https://api.saturam.com");
    });

    it("validates valid http and https URLs", () => {
        expect(isValidHttpUrl("https://github.com")).toBe(true);
        expect(isValidHttpUrl("http://localhost:8080")).toBe(true);
        expect(isValidHttpUrl("not-a-url")).toBe(false);
        expect(isValidHttpUrl("ftp://files.com")).toBe(false);
    });
});
