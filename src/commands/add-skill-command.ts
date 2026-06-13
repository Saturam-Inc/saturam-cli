import { select } from "@inquirer/prompts";
import { copyFile, mkdir, readdir, readFile, writeFile } from "fs/promises";
import { getLogger } from "log4js";
import { join } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { TypedCommand, TypedInputs } from "./base";

const logger = getLogger("AddSkillCommand");

interface SkillDefinition {
    name: string;
    description: string;
    skillDir: string;
}

// From built/commands/ -> ../../skills = package root /skills
const SKILLS_DIR = join(__dirname, "..", "..", "skills");

const TOOL_TARGETS = {
    "claude-code": {
        label: "Claude Code",
        getInstallDir: (skillName: string) => join(process.env.HOME || "~", ".claude", "skills", skillName),
    },
    cursor: {
        label: "Cursor",
        getInstallDir: (_skillName: string) => join(process.env.HOME || "~", ".cursor", "rules"),
    },
} as const;

type ToolTarget = keyof typeof TOOL_TARGETS;

const INPUTS = [
    {
        name: "skill",
        description: "Skill name to install (interactive if omitted)",
        schema: z.string().optional(),
        argument: true,
    },
    {
        name: "tool",
        description: "Target tool: claude-code or cursor",
        schema: z.string().optional(),
    },
] as const;

@Service()
export class AddSkillCommand implements TypedCommand<typeof INPUTS> {
    readonly name = "add-skill";
    readonly description = "Install a skill (e.g. code-review) into Claude Code or Cursor";
    readonly category = "common" as const;
    readonly aliases = ["skill"];
    readonly inputs = INPUTS;

    public async execute(inputs: TypedInputs<typeof INPUTS>): Promise<void> {
        // Step 1: List available skills
        const skills = await this.getAvailableSkills();
        if (skills.length === 0) {
            logger.error("No skills available.");
            return;
        }

        // Step 2: Select skill
        const selectedSkillName = inputs.skill
            ? inputs.skill
            : await select({
                message: "Select a skill to install:",
                choices: skills.map((s) => ({
                    name: `${s.name} — ${s.description}`,
                    value: s.name,
                })),
            });
        const selectedSkill = skills.find((s) => s.name === selectedSkillName);
        if (!selectedSkill) {
            logger.error(`Skill "${selectedSkillName}" not found. Available: ${skills.map((s) => s.name).join(", ")}`);
            return;
        }

        // Step 3: Select target tool
        const tool: ToolTarget = inputs.tool && inputs.tool in TOOL_TARGETS
            ? inputs.tool as ToolTarget
            : await select({
                message: "Install to:",
                choices: [
                    { name: "Claude Code", value: "claude-code" as ToolTarget },
                    { name: "Cursor", value: "cursor" as ToolTarget },
                ],
            });

        // Step 4: Install
        await this.installSkill(selectedSkill, tool);
    }

    private async getAvailableSkills(): Promise<SkillDefinition[]> {
        const skills: SkillDefinition[] = [];
        try {
            const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const skillDir = join(SKILLS_DIR, entry.name);
                const skillFile = join(skillDir, "SKILL.md");
                try {
                    const content = await readFile(skillFile, "utf8");
                    const description = this.parseDescription(content);
                    skills.push({ name: entry.name, description, skillDir });
                } catch {
                    // Skip dirs without SKILL.md
                }
            }
        } catch {
            logger.error(`Skills directory not found at ${SKILLS_DIR}`);
        }
        return skills;
    }

    private parseDescription(content: string): string {
        const match = content.match(/description:\s*"([^"]+)"/);
        return match ? match[1] : "No description";
    }

    private async installSkill(skill: SkillDefinition, tool: ToolTarget): Promise<void> {
        const target = TOOL_TARGETS[tool];
        const installDir = target.getInstallDir(skill.name);

        await mkdir(installDir, { recursive: true });

        if (tool === "claude-code") {
            // Copy SKILL.md directly
            const src = join(skill.skillDir, "SKILL.md");
            const dest = join(installDir, "SKILL.md");
            await copyFile(src, dest);
            logger.info(`✓ Installed "${skill.name}" to Claude Code`);
            logger.info(`  → ${dest}`);
        } else if (tool === "cursor") {
            // Convert SKILL.md to a .mdc rule file for Cursor
            const content = await readFile(join(skill.skillDir, "SKILL.md"), "utf8");
            const ruleFile = join(installDir, `${skill.name}.mdc`);
            await writeFile(ruleFile, content, "utf8");
            logger.info(`✓ Installed "${skill.name}" to Cursor`);
            logger.info(`  → ${ruleFile}`);
        }
    }
}
