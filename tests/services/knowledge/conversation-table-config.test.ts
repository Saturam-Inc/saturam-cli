import { CloudProvider, ConfigService } from "../../../src/services/config-service";

/**
 * Pins the path from `sat-cli init` to the store: the table name, region and retention come from
 * the saved config and nowhere else. A hardcoded table, region or account anywhere in this chain
 * would make the CLI work on one machine and silently fail on another.
 */
describe("conversation table configuration", () => {
    function serviceWith(aws: Record<string, unknown> | undefined) {
        const service = new ConfigService({} as any);
        (service as any).loadPersonalConfig = async () => ({
            cloud: aws ? { [CloudProvider.AWS]: aws } : undefined,
        });
        return service;
    }

    it("reads the table name from the saved config", async () => {
        const config = serviceWith({ awsRegion: "eu-west-2", conversationTable: { tableName: "team-chats" } });

        await expect(config.getConversationTableConfig()).resolves.toEqual({
            tableName: "team-chats",
            region: "eu-west-2",
            ttlDays: 90,
        });
    });

    it("inherits the account's AWS region when the table has none of its own", async () => {
        const config = serviceWith({ awsRegion: "ap-south-1", conversationTable: { tableName: "t" } });

        await expect(config.getConversationTableConfig()).resolves.toMatchObject({ region: "ap-south-1" });
    });

    it("lets an explicit table region override the account region", async () => {
        const config = serviceWith({
            awsRegion: "us-east-1",
            conversationTable: { tableName: "t", region: "eu-central-1" },
        });

        await expect(config.getConversationTableConfig()).resolves.toMatchObject({ region: "eu-central-1" });
    });

    it("honours a configured retention period instead of the default", async () => {
        const config = serviceWith({ awsRegion: "us-east-1", conversationTable: { tableName: "t", ttlDays: 30 } });

        await expect(config.getConversationTableConfig()).resolves.toMatchObject({ ttlDays: 30 });
    });

    it("returns undefined when no table is configured, so history stays in memory", async () => {
        const config = serviceWith({ awsRegion: "us-east-1" });

        await expect(config.getConversationTableConfig()).resolves.toBeUndefined();
    });

    it("returns undefined when no region can be resolved, rather than guessing one", async () => {
        const config = serviceWith({ conversationTable: { tableName: "t" } });

        await expect(config.getConversationTableConfig()).resolves.toBeUndefined();
    });

    it("returns undefined when AWS cloud is not configured at all", async () => {
        const config = serviceWith(undefined);

        await expect(config.getConversationTableConfig()).resolves.toBeUndefined();
    });
});
