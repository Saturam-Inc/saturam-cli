import { getLogger } from "log4js";
import { Service } from "typedi";
import { JiraAdfMark, JiraAdfNode } from "../../integrations/jira/models/jira.model";

const logger = getLogger("AdfNormalizerService");

@Service()
export class AdfNormalizerService {
    public renderAdfNode(node: JiraAdfNode, orderedIndex?: number): string {
        if (!node) return "";

        switch (node.type) {
            case "doc":
                return this.renderChildren(node.content, "\n\n");

            case "paragraph":
                return this.renderChildren(node.content) + "\n";

            case "heading": {
                const level = Number(node.attrs?.level) || 1;
                const hashes = "#".repeat(level);
                return `\n${hashes} ${this.renderChildren(node.content)}\n`;
            }

            case "text": {
                const rawText = node.text || "";
                const marks = node.marks || [];
                return marks.reduce((accText: string, mark: JiraAdfMark) => {
                    if (mark.type === "strong") return `**${accText}**`;
                    if (mark.type === "em") return `*${accText}*`;
                    if (mark.type === "code") return `\`${accText}\``;
                    if (mark.type === "strike") return `~~${accText}~~`;
                    if (mark.type === "link") {
                        const href = String(mark.attrs?.href || "");
                        return `[${accText}](${href})`;
                    }
                    return accText;
                }, rawText);
            }

            case "bulletList":
                return "\n" + this.renderChildren(node.content, "") + "\n";

            case "orderedList": {
                const content = node.content || [];
                const lines = content.map((child: JiraAdfNode, i: number) => this.renderAdfNode(child, i + 1));
                return `\n${lines.join("")}\n`;
            }

            case "listItem": {
                const prefix = orderedIndex !== undefined ? `${orderedIndex}. ` : "- ";
                const inner = this.renderChildren(node.content, "").trim();
                return `${prefix}${inner}\n`;
            }

            case "codeBlock": {
                const lang = String(node.attrs?.language || "");
                const code = this.renderChildren(node.content);
                return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`;
            }

            case "blockquote":
                return `\n> ${this.renderChildren(node.content, "\n> ")}\n`;

            case "rule":
                return "\n---\n";

            case "hardBreak":
                return "\n";

            case "mention": {
                const text = String(node.attrs?.text || "");
                if (text) {
                    return text.startsWith("@") ? text : `@${text}`;
                }
                return node.attrs?.id ? `@User:${String(node.attrs.id)}` : "@User";
            }

            default:
                logger.warn(`Unhandled ADF node type encountered: ${node.type}`);
                return node.content ? this.renderChildren(node.content) : "";
        }
    }

    private renderChildren(content: JiraAdfNode[] | undefined, separator = ""): string {
        if (!content || !Array.isArray(content)) return "";
        return content.map((c) => this.renderAdfNode(c)).join(separator);
    }
}
