import { z } from "zod";
import { StructuredOutputService } from "../../../src/services/knowledge/structured-output";

const Schema = z.object({ intent: z.string(), hints: z.array(z.string()).default([]) });

describe("StructuredOutputService", () => {
    function build(model: unknown, promptImpl?: jest.Mock) {
        const llm = {
            getModel: jest.fn().mockResolvedValue(model),
            prompt: promptImpl ?? jest.fn(),
        } as any;
        return { llm, service: new StructuredOutputService(llm) };
    }

    const request = {
        schema: Schema,
        name: "classify",
        shapeHint: '{ "intent": string, "hints": string[] }',
        messages: [],
    };

    it("uses native structured output when the provider supports it", async () => {
        const invoke = jest.fn().mockResolvedValue({ intent: "general_technical", hints: [] });
        const { llm, service } = build({ withStructuredOutput: jest.fn().mockReturnValue({ invoke }) });

        const result = await service.invoke(request);

        expect(result.intent).toBe("general_technical");
        expect(llm.prompt).not.toHaveBeenCalled();
    });

    it("falls back to instructed JSON on providers without tool calling", async () => {
        // SelfHostedChatModel is a bare `invoke` — failing here would make the whole agent flow
        // unavailable to self-hosted and some Ollama users.
        const prompt = jest.fn().mockResolvedValue('{"intent":"project_knowledge","hints":["smile"]}');
        const { service } = build({ invoke: jest.fn() }, prompt);

        const result = await service.invoke(request);

        expect(result).toEqual({ intent: "project_knowledge", hints: ["smile"] });
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("strips code fences a model wraps its JSON in", async () => {
        const prompt = jest.fn().mockResolvedValue('```json\n{"intent":"meta","hints":[]}\n```');
        const { service } = build({ invoke: jest.fn() }, prompt);

        await expect(service.invoke(request)).resolves.toMatchObject({ intent: "meta" });
    });

    it("retries once when the first response does not parse", async () => {
        const prompt = jest
            .fn()
            .mockResolvedValueOnce("sorry, here you go:")
            .mockResolvedValueOnce('{"intent":"meta","hints":[]}');
        const { service } = build({ invoke: jest.fn() }, prompt);

        const result = await service.invoke(request);

        expect(result.intent).toBe("meta");
        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it("falls back to JSON when native structured output throws", async () => {
        const invoke = jest.fn().mockRejectedValue(new Error("tool use unsupported"));
        const prompt = jest.fn().mockResolvedValue('{"intent":"meta","hints":[]}');
        const { service } = build({ withStructuredOutput: jest.fn().mockReturnValue({ invoke }) }, prompt);

        await expect(service.invoke(request)).resolves.toMatchObject({ intent: "meta" });
    });

    it("throws with the validation error when both attempts fail", async () => {
        const prompt = jest.fn().mockResolvedValue("not json at all");
        const { service } = build({ invoke: jest.fn() }, prompt);

        await expect(service.invoke(request)).rejects.toThrow(/did not return valid JSON for "classify"/);
    });
});
