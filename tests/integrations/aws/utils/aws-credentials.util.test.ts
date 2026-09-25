import { resolveAwsClientConfig } from "../../../../src/integrations/aws/utils/aws-credentials.util";

describe("resolveAwsClientConfig", () => {
    const originalEnv = process.env.AWS_REGION;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.AWS_REGION;
        } else {
            process.env.AWS_REGION = originalEnv;
        }
    });

    it("uses the configured region when present", async () => {
        delete process.env.AWS_REGION;
        const result = await resolveAwsClientConfig({ enabled: true, awsRegion: "ap-south-1" });
        expect(result.region).toBe("ap-south-1");
    });

    it("falls back to the AWS_REGION env var when no region is configured", async () => {
        process.env.AWS_REGION = "eu-west-1";
        const result = await resolveAwsClientConfig({ enabled: true });
        expect(result.region).toBe("eu-west-1");
    });

    it("throws when neither a configured region nor AWS_REGION is available", async () => {
        delete process.env.AWS_REGION;
        await expect(resolveAwsClientConfig({ enabled: true })).rejects.toThrow("AWS region is not configured");
    });

    it("returns explicit key credentials when auth method is 'keys'", async () => {
        const result = await resolveAwsClientConfig({
            enabled: true,
            awsRegion: "us-east-1",
            awsAuthMethod: "keys",
            awsAccessKeyId: "AKIA...",
            awsSecretAccessKey: "secret",
        });
        expect(result.region).toBe("us-east-1");
        await expect(result.credentials?.()).resolves.toEqual({
            accessKeyId: "AKIA...",
            secretAccessKey: "secret",
            sessionToken: undefined,
        });
    });

    it("falls back to the default credential provider chain when nothing else is set", async () => {
        const result = await resolveAwsClientConfig({ enabled: true, awsRegion: "us-east-1" });
        expect(result.credentials).toBeUndefined();
    });
});
