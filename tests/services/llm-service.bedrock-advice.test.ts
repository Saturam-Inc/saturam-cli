import { bedrockInferenceProfilePrefix, explainBedrockModelError } from "../../src/services/llm-service";

describe("explainBedrockModelError", () => {
    it("turns Bedrock's bare rejection into the two ways to name the right inference profile", () => {
        const advice = explainBedrockModelError(new Error("The provided model identifier is invalid."));

        expect(advice).toContain("Change default model");
        expect(advice).toContain("Custom Bedrock model");
        expect(advice).toContain("SATENG_BEDROCK_PROFILE_PREFIX");
        expect(advice).toContain("aws bedrock list-inference-profiles");
    });

    it("says nothing about any other error", () => {
        expect(explainBedrockModelError(new Error("AccessDeniedException"))).toBeUndefined();
        expect(explainBedrockModelError("timeout")).toBeUndefined();
    });

    it("derives a geography prefix from the region unless the override names one", () => {
        expect(bedrockInferenceProfilePrefix("ap-south-1", undefined)).toBe("apac");
        expect(bedrockInferenceProfilePrefix("eu-west-1", undefined)).toBe("eu");
        expect(bedrockInferenceProfilePrefix("us-east-1", undefined)).toBe("us");
        expect(bedrockInferenceProfilePrefix("ap-south-1", "global")).toBe("global");
        expect(bedrockInferenceProfilePrefix("ap-south-1", "in")).toBe("in");
    });
});
