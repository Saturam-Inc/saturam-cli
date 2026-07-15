export interface KnowledgeDocument {
    id: string;
    source: string;
    title: string;
    content: string;
    url: string;
    metadata: {
        updatedAt?: string;
        author?: string;
        labels?: string[];
    };
}

export interface KnowledgeSource {
    fetch(id: string, options?: Record<string, any>): Promise<KnowledgeDocument>;
}
