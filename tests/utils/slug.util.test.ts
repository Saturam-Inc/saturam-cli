import { slugify } from "../../src/utils/slug.util";

describe("slugify", () => {
    it("lowercases and replaces non-alphanumeric runs with the separator", () => {
        expect(slugify("My Project")).toBe("my-project");
        expect(slugify("My_Project 123!!")).toBe("my-project-123");
    });

    it("trims leading/trailing separators", () => {
        expect(slugify("  Project  ")).toBe("project");
    });

    it("supports a custom separator", () => {
        expect(slugify("My Project", "_")).toBe("my_project");
    });

    it("preserves non-ASCII letters instead of collapsing them to nothing", () => {
        expect(slugify("日本語プロジェクト")).toBe("日本語プロジェクト");
        expect(slugify("Café Münich")).toBe("café-münich");
    });

    it("returns an empty string for input with no letters or digits", () => {
        expect(slugify("!!!")).toBe("");
    });
});
