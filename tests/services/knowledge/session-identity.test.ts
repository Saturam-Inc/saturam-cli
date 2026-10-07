import {
    describeOwner,
    getOwnerId,
    isValidSessionId,
    newSessionId,
} from "../../../src/services/knowledge/session-identity";

describe("session identity", () => {
    it("derives a stable owner from the machine and OS user", () => {
        // Derived rather than stored: every terminal on a machine resolves to the same owner with
        // nothing to keep in sync, and no config file to lose.
        expect(getOwnerId()).toBe(getOwnerId());
        expect(getOwnerId()).toMatch(/^owner#[^#]+#[^#]+$/);
    });

    it("renders an owner readably for logs", () => {
        expect(describeOwner("owner#vinoth#ubuntu")).toBe("ubuntu@vinoth");
    });

    it("mints session ids that sort chronologically as strings", () => {
        // This is what makes "continue the newest conversation" a single descending query
        // instead of a scan.
        const morning = newSessionId(new Date("2026-09-18T09:00:00Z"));
        const afternoon = newSessionId(new Date("2026-09-18T13:30:00Z"));
        const nextDay = newSessionId(new Date("2026-09-19T08:00:00Z"));

        expect([afternoon, nextDay, morning].sort()).toEqual([morning, afternoon, nextDay]);
    });

    it("keeps two sessions started in the same second distinct", () => {
        const at = new Date("2026-09-18T09:00:00Z");
        expect(newSessionId(at)).not.toBe(newSessionId(at));
    });

    it("mints ids free of the sort-key separator, so they parse back out", () => {
        expect(isValidSessionId(newSessionId())).toBe(true);
        expect(isValidSessionId("has#hash")).toBe(false);
    });
});
