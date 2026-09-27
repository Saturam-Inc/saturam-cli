import { bedrockInferenceProfilePrefix } from "../../src/services/llm-service";

describe("bedrockInferenceProfilePrefix", () => {
    it.each([
        ["us-east-1", "us"],
        ["us-west-2", "us"],
        ["eu-central-1", "eu"],
        // Asia Pacific's cross-region profiles are "apac.", not "ap." — the latter does not exist.
        ["ap-south-1", "apac"],
        ["ap-southeast-2", "apac"],
    ])("maps %s to %s", (region, prefix) => {
        expect(bedrockInferenceProfilePrefix(region, undefined)).toBe(prefix);
    });

    it("lets an explicit prefix win, for the global or a country-level profile", () => {
        expect(bedrockInferenceProfilePrefix("ap-south-1", "global")).toBe("global");
    });
});
