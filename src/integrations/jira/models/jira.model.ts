// --- ADF (Atlassian Document Format) ---

export interface JiraAdfMark {
    type: string;
    attrs?: Record<string, string>;
}

export interface JiraAdfNode {
    type: string;
    text?: string;
    content?: JiraAdfNode[];
    marks?: JiraAdfMark[];
    attrs?: Record<string, string | number | boolean>;
}

// --- Issue API Response ---

export interface JiraComment {
    id?: string;
    author?: { displayName?: string; accountId?: string };
    created?: string;
    updated?: string;
    body?: JiraAdfNode;
}

export interface JiraIssueFields {
    summary?: string;
    status?: { id?: string; name?: string };
    assignee?: { displayName?: string; accountId?: string };
    reporter?: { displayName?: string; accountId?: string };
    priority?: { id?: string; name?: string };
    issuetype?: { id?: string; name?: string };
    created?: string;
    updated?: string;
    description?: JiraAdfNode;
    comment?: { comments?: JiraComment[]; total?: number };
    labels?: string[];
    project?: { id?: string; key?: string; name?: string };
}

export interface JiraIssueApiResponse {
    id?: string;
    key: string;
    self?: string;
    fields?: JiraIssueFields;
}

// --- Search API Response ---

export interface JiraSearchIssue {
    id?: string;
    key: string;
    self?: string;
    fields?: Pick<JiraIssueFields, "summary" | "status" | "assignee" | "priority" | "issuetype" | "labels">;
}

export interface JiraSearchApiResponse {
    total?: number;
    maxResults?: number;
    startAt?: number;
    issues?: JiraSearchIssue[];
}

// --- Project API Response ---

export interface JiraProject {
    id: string;
    key: string;
    name: string;
    self?: string;
    projectTypeKey?: string;
}

export interface JiraProjectsApiResponse {
    values?: JiraProject[];
    total?: number;
}

// --- Board API Response ---

export interface JiraBoard {
    id: number;
    name: string;
    type?: string;
    self?: string;
}

export interface JiraBoardsApiResponse {
    values?: JiraBoard[];
    total?: number;
}

// --- Sprint API Response ---

export interface JiraSprint {
    id: number;
    name: string;
    state?: "active" | "closed" | "future";
    startDate?: string;
    endDate?: string;
    self?: string;
}

export interface JiraSprintsApiResponse {
    values?: JiraSprint[];
    total?: number;
}
