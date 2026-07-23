import { Service } from "typedi";

@Service()
export class HtmlNormalizerService {
    public convertHtmlToMarkdown(html: string): string {
        if (!html) return "";

        return html
            .replace(
                /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/gi,
                (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`,
            )
            .replace(
                /<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/gi,
                (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`,
            )
            .replace(/<ac:structured-macro[^>]*>/gi, "")
            .replace(/<\/ac:structured-macro>/gi, "")
            .replace(/<ac:parameter[^>]*>([\s\S]*?)<\/ac:parameter>/gi, "")
            .replace(
                /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
                (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`,
            )
            .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`)
            .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${code}\``)
            .replace(/<a[^>]*class="[^"]*(confluence-userlink|user-mention)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, "@$2")
            .replace(
                /<ac:link>\s*<ri:user[^>]*\/>\s*<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>\s*<\/ac:plain-text-link-body>\s*<\/ac:link>/gi,
                "@$1",
            )
            .replace(
                /<ac:link>\s*<ri:user[^>]*\/>\s*<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>\s*<\/ac:link>/gi,
                "@$1",
            )
            .replace(/<ac:link>\s*<ri:user[^>]*\/>\s*<ac:link-body>([\s\S]*?)<\/ac:link-body>\s*<\/ac:link>/gi, "@$1")
            .replace(/<ac:link>\s*<ri:user[^>]*ri:username="([^"]*)"[^>]*\/>\s*<\/ac:link>/gi, "@$1")
            .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (tableHtml) => this.convertTable(tableHtml))
            .replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, (listHtml, type) => this.convertList(listHtml, type === "ol"))
            .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
            .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
            .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
            .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
            .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
            .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
            .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
            .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
            .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
            .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")
            .replace(/<strike[^>]*>([\s\S]*?)<\/strike>/gi, "~~$1~~")
            .replace(/<del[^>]*>([\s\S]*?)<\/del>/gi, "~~$1~~")
            .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    private convertTable(tableHtml: string): string {
        const rowHtmls = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
        const rows = rowHtmls.map((rowHtml) => {
            const cellHtmls = rowHtml.match(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi) || [];
            return cellHtmls.map((cellHtml) => {
                const cellText = cellHtml.replace(/<(td|th)[^>]*>|<\/\1>/gi, "").trim();
                return this.convertHtmlToMarkdown(cellText).trim().replace(/\n/g, " ").replace(/\|/g, "\\|");
            });
        });

        if (rows.length === 0) return "";
        const firstRow = rows[0];
        const headerLine = "| " + firstRow.join(" | ") + " |";
        const dividerLine = "| " + firstRow.map(() => ":---").join(" | ") + " |";
        const dataLines = rows.slice(1).map((row) => {
            const paddedRow = row.concat(Array(Math.max(0, firstRow.length - row.length)).fill(""));
            return "| " + paddedRow.slice(0, firstRow.length).join(" | ") + " |";
        });

        return "\n" + [headerLine, dividerLine, ...dataLines].join("\n") + "\n";
    }

    private convertList(listHtml: string, isOrdered: boolean, depth: number = 0): string {
        const itemHtmls = listHtml.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
        const indent = "  ".repeat(depth);
        const prefix = isOrdered ? "1. " : "- ";

        return itemHtmls
            .map((itemHtml) => {
                const rawText = itemHtml.replace(/<li[^>]*>|<\/li>/gi, "");
                const nestedListMatch = rawText.match(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi);

                if (nestedListMatch) {
                    const innerListHtml = nestedListMatch[0];
                    const innerListType = nestedListMatch[1];
                    const textBefore = rawText.replace(innerListHtml, "").trim();
                    const textMarkdown = this.convertHtmlToMarkdown(textBefore).trim();
                    const nestedMarkdown = this.convertList(innerListHtml, innerListType === "ol", depth + 1);
                    return `${indent}${prefix}${textMarkdown}\n${nestedMarkdown}`;
                }

                const textMarkdown = this.convertHtmlToMarkdown(rawText).trim();
                return `${indent}${prefix}${textMarkdown}`;
            })
            .join("\n");
    }
}
