import { RetrievalPlannerAgent } from "../../../../src/services/knowledge/agents/retrieval-planner.agent";

describe("RetrievalPlannerAgent", () => {
    let structured: any;
    let agent: RetrievalPlannerAgent;

    beforeEach(() => {
        structured = {
            invoke: jest.fn().mockResolvedValue({
                intent: "move the weekly DAG run to Friday",
                queries: [
                    "where the Airflow DAG schedule is configured",
                    "how DAG runs are triggered",
                    "what reads the DAG output",
                ],
            }),
        };
        agent = new RetrievalPlannerAgent(structured);
    });

    it("returns the planned searches", async () => {
        const plan = await agent.plan({ question: "how do I move the schedule to Friday?" });

        expect(plan.queries).toHaveLength(3);
        expect(plan.intent).toBe("move the weekly DAG run to Friday");
    });

    it("caps the plan so extra searches stop returning each other's documents", async () => {
        structured.invoke.mockResolvedValue({ intent: "", queries: ["a", "b", "c", "d", "e", "f"] });

        const plan = await agent.plan({ question: "q" });

        expect(plan.queries).toEqual(["a", "b", "c", "d"]);
    });

    it("drops duplicates that differ only in case or spacing", async () => {
        structured.invoke.mockResolvedValue({
            intent: "",
            queries: ["Where The Schedule Lives", "where the schedule lives", "  where the schedule lives  ", "other"],
        });

        const plan = await agent.plan({ question: "q" });

        expect(plan.queries).toEqual(["Where The Schedule Lives", "other"]);
    });

    it("falls back to the question when the plan comes back empty", async () => {
        structured.invoke.mockResolvedValue({ intent: "", queries: [] });

        const plan = await agent.plan({ question: "how do I move the schedule?" });

        expect(plan.queries).toEqual(["how do I move the schedule?"]);
    });

    it("falls back to the question when planning fails, since planning is an optimisation", async () => {
        structured.invoke.mockRejectedValue(new Error("model unavailable"));

        const plan = await agent.plan({ question: "how do I move the schedule?" });

        expect(plan.queries).toEqual(["how do I move the schedule?"]);
    });

    it("tells the planner which project and what was being discussed", async () => {
        await agent.plan({
            question: "and how would I change it?",
            projectDisplayName: "MRF Engg Analytics",
            priorSubject: "the scheduler daemon triggers the DAGs",
        });

        const [{ messages }] = structured.invoke.mock.calls[0];
        expect(String(messages[0].content)).toContain("MRF Engg Analytics");
        expect(String(messages[1].content)).toContain("the scheduler daemon triggers the DAGs");
    });
});
