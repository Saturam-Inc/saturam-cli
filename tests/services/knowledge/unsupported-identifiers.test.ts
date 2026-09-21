import {
    extractIdentifiers,
    findUnsupportedIdentifiers,
} from "../../../src/services/knowledge/unsupported-identifiers";

describe("unsupported identifiers", () => {
    const sources = `
The weekly trigger lives in mrf_scheduler/airflow_scheduler.py, a schedule-library daemon.
It shells out to cons.sh, spare.sh and should_cost.sh. Each runs \`airflow resetdb\` then a backfill.
Snapshots land in /home/ubuntu/mrf/pkl/. The kpi APIs read them. Port 8080 serves the spares cache.
`;

    describe("extractIdentifiers", () => {
        it("pulls backticked code tokens, paths and file names", () => {
            const ids = extractIdentifiers(
                "Edit `kpi/pkl_path.py`, then run cons.sh from mrf_scheduler/ on port 8080.",
            );

            expect(ids).toEqual(expect.arrayContaining(["kpi/pkl_path.py", "cons.sh"]));
        });

        it("ignores backticked plain words, which are prose in code font, not identifiers", () => {
            expect(extractIdentifiers("rows are marked `false` while `true` rows follow")).toEqual([]);
        });

        it("ignores backticked commands and phrases containing spaces", () => {
            expect(extractIdentifiers("run `airflow clear cons_dag` first")).toEqual([]);
        });

        it("ignores wildcards, placeholders and templating, which are never literal names", () => {
            const ids = extractIdentifiers("see `mrf_scheduler/*.sh`, `airflow clear <dag_id>`, and `${HOME}/x.py`");

            expect(ids).toEqual([]);
        });

        it("ignores URLs and bare version numbers", () => {
            expect(extractIdentifiers("Airflow 1.10.8 at https://example.com/docs/x.md")).toEqual([]);
        });

        it("strips surrounding punctuation from a path at the end of a sentence", () => {
            expect(extractIdentifiers("Look in kpi/config.py.")).toEqual(["kpi/config.py"]);
        });
    });

    describe("findUnsupportedIdentifiers", () => {
        it("flags a file the sources never mention", () => {
            const flagged = findUnsupportedIdentifiers(
                "Restart `mrf_scheduler/table_scheduler.py` afterwards.",
                sources,
            );

            expect(flagged).toEqual(["mrf_scheduler/table_scheduler.py"]);
        });

        it("accepts a path when the sources contain its last segment, since writers compose paths", () => {
            const flagged = findUnsupportedIdentifiers("Run `mrf_scheduler/cons.sh` on Sunday.", sources);

            expect(flagged).toEqual([]);
        });

        it("accepts identifiers the sources contain in any case", () => {
            expect(findUnsupportedIdentifiers("open Airflow_Scheduler.py", sources)).toEqual([]);
        });

        it("counts earlier answers in the conversation as support", () => {
            const prior = ["The raw tables are reset by table_scheduler.py every Saturday."];

            expect(findUnsupportedIdentifiers("As we saw, `table_scheduler.py` runs first.", sources, prior)).toEqual(
                [],
            );
        });

        it("flags nothing when there are no sources to check against", () => {
            expect(findUnsupportedIdentifiers("Edit `kpi/pkl_path.py`.", "")).toEqual([]);
        });

        it("reports each identifier once, however many times the answer uses it", () => {
            const answer = "Edit `nowhere/missing.py`. Then re-run nowhere/missing.py and check missing.py.";

            expect(findUnsupportedIdentifiers(answer, sources)).toEqual(["nowhere/missing.py"]);
        });
    });
});
