import { getLogger } from "log4js";
import { Service } from "typedi";
import { GitService } from "../github/services/git.service";
import { GitHubSCMService } from "../github/services/github-scm.service";
import { BitbucketSCMService } from "../bitbucket/services/bitbucket-scm.service";
import { GitLabSCMService } from "../gitlab/services/gitlab-scm.service";
import { ConfigService } from "../../services/config-service";
import { SCMProvider, SCMService } from "./scm.model";

const logger = getLogger("SCMFactory");

@Service()
export class SCMFactory {
    constructor(
        private readonly git: GitService,
        private readonly github: GitHubSCMService,
        private readonly bitbucket: BitbucketSCMService,
        private readonly gitlab: GitLabSCMService,
        private readonly config: ConfigService,
    ) {}

    public async detect(): Promise<SCMService> {
        const remoteUrl = await this.git.getRemoteUrl();

        // Check configured self-hosted GitLab instance URL before falling back to static detection
        const instanceUrl = await this.config.getGitLabInstanceUrl();
        if (instanceUrl) {
            const instanceHost = new URL(instanceUrl).hostname;
            if (remoteUrl.includes(instanceHost)) {
                logger.debug(`Detected GitLab (self-hosted: ${instanceHost}) from remote: ${remoteUrl}`);
                return this.gitlab;
            }
        }

        const provider = SCMFactory.detectProvider(remoteUrl);
        logger.debug(`Detected SCM provider: ${provider} from remote: ${remoteUrl}`);

        switch (provider) {
            case SCMProvider.GITHUB:
                return this.github;
            case SCMProvider.BITBUCKET:
                return this.bitbucket;
            case SCMProvider.GITLAB:
                return this.gitlab;
        }
    }

    public get(provider: SCMProvider): SCMService {
        switch (provider) {
            case SCMProvider.GITHUB:
                return this.github;
            case SCMProvider.BITBUCKET:
                return this.bitbucket;
            case SCMProvider.GITLAB:
                return this.gitlab;
        }
    }

    public static detectProvider(remoteUrl: string): SCMProvider {
        if (remoteUrl.includes("github.com")) {
            return SCMProvider.GITHUB;
        }
        if (remoteUrl.includes("bitbucket.org")) {
            return SCMProvider.BITBUCKET;
        }
        if (remoteUrl.includes("gitlab.com")) {
            return SCMProvider.GITLAB;
        }
        throw new Error(
            `Could not detect SCM provider from remote URL: ${remoteUrl}. Supported: GitHub, Bitbucket, GitLab.`,
        );
    }

    public static parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } {
        // Handles:
        //   git@github.com:owner/repo.git
        //   https://github.com/owner/repo.git
        //   git@bitbucket.org:workspace/repo.git
        //   https://bitbucket.org/workspace/repo.git
        const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
        if (!match) {
            throw new Error(`Could not parse owner/repo from remote URL: ${remoteUrl}`);
        }
        return { owner: match[1], repo: match[2] };
    }
}
