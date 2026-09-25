import { HumanMessage } from "@langchain/core/messages";
import { LLMModel } from "../../src/constants/llm-models";
import { AIProvider } from "../../src/services/config-service";
import type { ConfigService, ProviderConfig, RemoteConfig } from "../../src/services/config-service";
import { LlmService } from "../../src/services/llm-service";
import type { RemoteCredentialService, AwsCredentials } from "../../src/services/remote-credential.service";

// Capture the arguments passed to the Bedrock model constructor.
const bedrockConstructorArgs: any[] = [];
jest.mock("@langchain/aws", () => ({
    ChatBedrockConverse: class {
        public args: any;
        constructor(args: any) {
            this.args = args;
            bedrockConstructorArgs.push(args);
        }
        async invoke(_messages: any) {
            if (typeof this.args?.credentials === "function") {
                await this.args.credentials();
            }
            return { content: "Mock Bedrock response" };
        }
    },
}));

// Capture whether/how the local profile credential provider is used.
const fromIniMock = jest.fn((_args?: any) => "FROM_INI_PROVIDER");
jest.mock("@aws-sdk/credential-providers", () => ({
    fromIni: (args: any) => fromIniMock(args),
}));

function makeConfig(options: {
    providerConfig?: ProviderConfig;
    remote?: RemoteConfig;
}): ConfigService {
    return {
        getModel: jest.fn().mockResolvedValue(LLMModel.BEDROCK_CLAUDE_4_SONNET),
        getProviderConfig: jest.fn().mockResolvedValue(options.providerConfig),
        getRemoteConfig: jest.fn().mockResolvedValue(options.remote),
    } as unknown as ConfigService;
}

function makeRemoteCreds(credentials: AwsCredentials): RemoteCredentialService {
    return {
        getCredentials: jest.fn().mockResolvedValue(credentials),
    } as unknown as RemoteCredentialService;
}

describe("LlmService Bedrock credential resolution", () => {
    beforeEach(() => {
        bedrockConstructorArgs.length = 0;
        fromIniMock.mockClear();
        delete process.env.AWS_PROFILE;
    });

    it("fetches fresh static credentials on each prompt and bypasses client caching", async () => {
        const remoteCredentials1: AwsCredentials = {
            accessKeyId: "AKIA_REMOTE_1",
            secretAccessKey: "SECRET_REMOTE_1",
            sessionToken: "SESSION_1",
        };
        const remoteCredentials2: AwsCredentials = {
            accessKeyId: "AKIA_REMOTE_2",
            secretAccessKey: "SECRET_REMOTE_2",
            sessionToken: "SESSION_2",
        };
        const remoteCreds = {
            getCredentials: jest
                .fn()
                .mockResolvedValueOnce(remoteCredentials1)
                .mockResolvedValueOnce(remoteCredentials2),
        } as unknown as RemoteCredentialService;

        const config = makeConfig({
            providerConfig: { enabled: true, awsRegion: "us-east-1" },
            remote: { url: "https://example.com", token: "tok" },
        });

        const service = new LlmService(config, remoteCreds);

        // First prompt invocation with same model & options
        const res1 = await service.prompt([new HumanMessage("hello")], LLMModel.BEDROCK_CLAUDE_4_SONNET);
        expect(res1).toBe("Mock Bedrock response");
        expect(remoteCreds.getCredentials).toHaveBeenCalledTimes(1);
        expect(bedrockConstructorArgs[0].credentials).toEqual({
            accessKeyId: "AKIA_REMOTE_1",
            secretAccessKey: "SECRET_REMOTE_1",
            sessionToken: "SESSION_1",
        });

        // Second prompt invocation with identical model & options
        const res2 = await service.prompt([new HumanMessage("world")], LLMModel.BEDROCK_CLAUDE_4_SONNET);
        expect(res2).toBe("Mock Bedrock response");
        expect(remoteCreds.getCredentials).toHaveBeenCalledTimes(2);
        expect(bedrockConstructorArgs[1].credentials).toEqual({
            accessKeyId: "AKIA_REMOTE_2",
            secretAccessKey: "SECRET_REMOTE_2",
            sessionToken: "SESSION_2",
        });

        expect(fromIniMock).not.toHaveBeenCalled();
        expect(bedrockConstructorArgs).toHaveLength(2);
    });

    it("uses the local AWS profile when remote mode is not configured", async () => {
        const remoteCreds = makeRemoteCreds({ accessKeyId: "x", secretAccessKey: "y" });
        const config = makeConfig({
            providerConfig: { enabled: true, awsRegion: "us-east-1", awsProfile: "my-profile" },
            remote: undefined,
        });

        const service = new LlmService(config, remoteCreds);
        await service.getModel(LLMModel.BEDROCK_CLAUDE_4_SONNET);

        expect(remoteCreds.getCredentials).not.toHaveBeenCalled();
        expect(fromIniMock).toHaveBeenCalledWith({ profile: "my-profile" });
        expect(bedrockConstructorArgs[0].credentials).toBe("FROM_INI_PROVIDER");
    });

    it("falls back to the default credential chain when neither remote nor profile is set", async () => {
        const remoteCreds = makeRemoteCreds({ accessKeyId: "x", secretAccessKey: "y" });
        const config = makeConfig({
            providerConfig: { enabled: true, awsRegion: "us-east-1" },
            remote: undefined,
        });

        const service = new LlmService(config, remoteCreds);
        await service.getModel(LLMModel.BEDROCK_CLAUDE_4_SONNET);

        expect(remoteCreds.getCredentials).not.toHaveBeenCalled();
        expect(fromIniMock).not.toHaveBeenCalled();
        expect(bedrockConstructorArgs[0].credentials).toBeUndefined();
    });
});
