import { Service } from "typedi";
import { getGeneralTechnicalMessages } from "../../../prompts/general-technical.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, SessionDigest } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";

const TEMPERATURE = 0.3;

/** Answers questions that need no retrieval, while marking the line between general and house practice. */
@Service()
export class GeneralTechnicalAgent {
    constructor(
        private readonly llm: LlmService,
        private readonly registry: ProjectRegistryService,
    ) {}

    public async answer(params: {
        question: string;
        recentTurns: ChatTurn[];
        digest?: SessionDigest;
    }): Promise<string> {
        const { projects } = await this.registry.load();
        const messages = getGeneralTechnicalMessages({ ...params, hasIndexedProjects: projects.length > 0 });
        return this.llm.prompt(messages, undefined, { temperature: TEMPERATURE });
    }
}
