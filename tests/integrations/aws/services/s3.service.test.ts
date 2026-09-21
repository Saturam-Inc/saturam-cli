import { S3Service } from "../../../../src/integrations/aws/services/s3.service";
import { ConfigService } from "../../../../src/services/config-service";

const mockSend = jest.fn();
const mockS3Client = jest.fn().mockImplementation(() => ({ send: mockSend }));

jest.mock("@aws-sdk/client-s3", () => ({
    S3Client: mockS3Client,
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe("S3Service", () => {
    let service: S3Service;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            getAWSCloudConfig: jest.fn().mockResolvedValue({ enabled: true, awsRegion: "us-east-1" }),
            getS3Config: jest.fn().mockResolvedValue({ bucket: "my-bucket", prefix: "docs", region: "us-east-1" }),
        } as any;
        service = new S3Service(mockConfig);
    });

    it("creates the S3 client with the configured bucket region", async () => {
        mockConfig.getAWSCloudConfig.mockResolvedValueOnce({ enabled: true, awsRegion: "us-east-1" } as any);
        mockConfig.getS3Config.mockResolvedValueOnce({ bucket: "my-bucket", prefix: "docs", region: "ap-south-1" });
        mockSend.mockResolvedValueOnce({});

        await service.putObject("file.md", "content");

        expect(mockS3Client).toHaveBeenCalledWith(expect.objectContaining({ region: "ap-south-1" }));
    });

    it("getObject fetches from the prefixed key and returns a Buffer", async () => {
        mockSend.mockResolvedValueOnce({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([104, 105])) },
        });

        const result = await service.getObject("file.md");

        expect(result).toEqual(Buffer.from("hi"));
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: { Bucket: "my-bucket", Key: "docs/file.md" } }),
        );
    });

    it("getStateObject reads from the state prefix, not the content prefix", async () => {
        mockConfig.getS3Config.mockResolvedValue({
            bucket: "my-bucket",
            prefix: "onboarding",
            statePrefix: "onboarding-state",
            region: "us-east-1",
        });
        mockSend.mockResolvedValueOnce({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([104, 105])) },
        });

        const result = await service.getStateObject("registry.json");

        expect(result).toEqual(Buffer.from("hi"));
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: { Bucket: "my-bucket", Key: "onboarding-state/registry.json" } }),
        );
    });

    it("getStateObject falls back to the bucket root when no state prefix is configured", async () => {
        mockConfig.getS3Config.mockResolvedValue({ bucket: "my-bucket", prefix: "onboarding", region: "us-east-1" });
        mockSend.mockResolvedValueOnce({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([104, 105])) },
        });

        await service.getStateObject("registry.json");

        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: { Bucket: "my-bucket", Key: "registry.json" } }),
        );
    });

    it("putObject writes to the prefixed key", async () => {
        mockSend.mockResolvedValueOnce({});

        await service.putObject("file.md", "content", "text/markdown");

        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: { Bucket: "my-bucket", Key: "docs/file.md", Body: "content", ContentType: "text/markdown" },
            }),
        );
    });

    it("listObjects scopes to whole path segments so a sibling prefix does not leak in", async () => {
        mockSend.mockResolvedValueOnce({ Contents: [{ Key: "docs/a.md" }], IsTruncated: false });

        await service.listObjects();

        // Without the trailing slash, S3's literal prefix match would also return every key
        // under a sibling such as "docs-state/".
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({ Prefix: "docs/" }) }),
        );
    });

    it("listObjects paginates through all pages and returns keys", async () => {
        mockSend
            .mockResolvedValueOnce({
                Contents: [{ Key: "docs/a.md" }],
                IsTruncated: true,
                NextContinuationToken: "token-2",
            })
            .mockResolvedValueOnce({ Contents: [{ Key: "docs/b.md" }], IsTruncated: false });

        const keys = await service.listObjects();

        expect(keys).toEqual(["docs/a.md", "docs/b.md"]);
        expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("getObject throws a descriptive error when the SDK call fails", async () => {
        mockSend.mockRejectedValueOnce(new Error("Access Denied"));

        await expect(service.getObject("file.md")).rejects.toThrow(
            "Failed to get s3://my-bucket/docs/file.md: Access Denied",
        );
    });

    describe("objectExists", () => {
        it("returns true when HeadObjectCommand succeeds", async () => {
            mockSend.mockResolvedValueOnce({});

            const exists = await service.objectExists("file.md");

            expect(exists).toBe(true);
            expect(mockSend).toHaveBeenCalledWith(
                expect.objectContaining({ input: { Bucket: "my-bucket", Key: "docs/file.md" } }),
            );
        });

        it("returns false when the object is not found (404)", async () => {
            const notFoundError = Object.assign(new Error("Not Found"), {
                name: "NotFound",
                $metadata: { httpStatusCode: 404 },
            });
            mockSend.mockRejectedValueOnce(notFoundError);

            const exists = await service.objectExists("missing.md");

            expect(exists).toBe(false);
        });

        it("re-throws non-404 errors", async () => {
            mockSend.mockRejectedValueOnce(new Error("Access Denied"));

            await expect(service.objectExists("file.md")).rejects.toThrow(
                "Failed to check s3://my-bucket/docs/file.md: Access Denied",
            );
        });
    });
});
