import { OnboardService } from "../../../src/services/onboarding/onboard.service";
import { ConfluenceService } from "../../../src/integrations/confluence/services/confluence.service";
import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../../../src/services/config-service";
import { AdfNormalizerService } from "../../../src/services/onboarding/adf-normalizer.service";
import { HtmlNormalizerService } from "../../../src/services/onboarding/html-normalizer.service";

describe("OnboardService", () => {
    let service: OnboardService;
    let mockConfluence: jest.Mocked<ConfluenceService>;
    let mockJira: jest.Mocked<JiraService>;
    let mockGoogleDrive: jest.Mocked<GoogleDriveService>;
    let mockConfig: jest.Mocked<ConfigService>;
    let adfNormalizer: AdfNormalizerService;
    let htmlNormalizer: HtmlNormalizerService;

    beforeEach(() => {
        mockConfluence = {
            getPage: jest.fn(),
            getPageMetadata: jest.fn(),
            listChildPages: jest.fn(),
            listSpaces: jest.fn(),
            listPagesInSpace: jest.fn(),
            searchContent: jest.fn(),
        } as any;
        mockJira = {
            getIssue: jest.fn(),
            getIssueMetadata: jest.fn(),
            searchIssueKeys: jest.fn(),
            searchIssues: jest.fn(),
            listChildIssues: jest.fn(),
            listProjects: jest.fn(),
            listBoards: jest.fn(),
            getBoardBacklogIssues: jest.fn(),
        } as any;
        mockGoogleDrive = {
            getFileMetadata: jest.fn(),
            getGoogleDoc: jest.fn(),
            exportGoogleDocAsMarkdown: jest.fn(),
            exportGoogleDocAsHtml: jest.fn(),
            getFileBinary: jest.fn(),
            listFilesInFolder: jest.fn(),
            searchFiles: jest.fn(),
            getSpreadsheetData: jest.fn(),
            getSpreadsheetMetadata: jest.fn(),
            batchGetSpreadsheetValues: jest.fn(),
        } as any;
        mockConfig = {
            getPersonalConfigPath: jest.fn().mockReturnValue("/mock/personal/config.json"),
        } as any;
        adfNormalizer = new AdfNormalizerService();
        htmlNormalizer = new HtmlNormalizerService();

        service = new OnboardService(
            mockConfluence,
            mockJira,
            mockGoogleDrive,
            mockConfig,
            adfNormalizer,
            htmlNormalizer,
        );
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });
});
