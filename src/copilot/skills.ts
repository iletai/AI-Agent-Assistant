import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { SKILLS_DIR } from "../paths.js";

/** User-local skills directory (~/.nzb/skills/) */
const LOCAL_SKILLS_DIR = SKILLS_DIR;

/** Global shared skills directory */
const GLOBAL_SKILLS_DIR = join(homedir(), ".agents", "skills");

/** Skills bundled with the NZB package (e.g. find-skills) */
const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

let cachedSkillDirs: string[] | undefined;

/** Returns all skill directories that exist on disk. Cached after first call. */
export function getSkillDirectories(): string[] {
	if (cachedSkillDirs) return cachedSkillDirs;
	const dirs: string[] = [];
	if (existsSync(BUNDLED_SKILLS_DIR)) dirs.push(BUNDLED_SKILLS_DIR);
	if (existsSync(LOCAL_SKILLS_DIR)) dirs.push(LOCAL_SKILLS_DIR);
	if (existsSync(GLOBAL_SKILLS_DIR)) dirs.push(GLOBAL_SKILLS_DIR);
	cachedSkillDirs = dirs;
	return dirs;
}

export function clearSkillDirsCache(): void {
	cachedSkillDirs = undefined;
}

export interface SkillInfo {
	slug: string;
	name: string;
	description: string;
	directory: string;
	source: "bundled" | "local" | "global";
}

/** Scan all skill directories and return metadata for each skill found. */
export function listSkills(): SkillInfo[] {
	const skills: SkillInfo[] = [];

	for (const [dir, source] of [
		[BUNDLED_SKILLS_DIR, "bundled"] as const,
		[LOCAL_SKILLS_DIR, "local"] as const,
		[GLOBAL_SKILLS_DIR, "global"] as const,
	]) {
		if (!existsSync(dir)) continue;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err: unknown) {
			console.error("[nzb] Failed to read skill directory", dir + ":", err instanceof Error ? err.message : err);
			continue;
		}

		for (const entry of entries) {
			const skillDir = join(dir, entry);
			const skillMd = join(skillDir, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			try {
				const content = readFileSync(skillMd, "utf-8");
				const { name, description } = parseFrontmatter(content);
				skills.push({
					slug: entry,
					name: name || entry,
					description: description || "(no description)",
					directory: skillDir,
					source,
				});
			} catch (err: unknown) {
				console.error("[nzb] Failed to parse SKILL.md for", entry + ":", err instanceof Error ? err.message : err);
				skills.push({
					slug: entry,
					name: entry,
					description: "(could not read SKILL.md)",
					directory: skillDir,
					source,
				});
			}
		}
	}

	return skills;
}

/** Create a new skill in the local skills directory. */
export function createSkill(slug: string, name: string, description: string, instructions: string): string {
	const skillDir = join(LOCAL_SKILLS_DIR, slug);
	// Guard against path traversal — resolve to canonical path and verify it stays inside skills dir
	const resolvedSkillDir = resolve(skillDir);
	const resolvedBase = resolve(LOCAL_SKILLS_DIR);
	if (!resolvedSkillDir.startsWith(resolvedBase + sep)) {
		return `Invalid slug '${slug}': must be a simple kebab-case name without path separators.`;
	}
	if (existsSync(skillDir)) {
		return `Skill '${slug}' already exists at ${skillDir}. Edit it directly or delete it first.`;
	}

	mkdirSync(skillDir, { recursive: true });

	writeFileSync(join(skillDir, "_meta.json"), JSON.stringify({ slug, version: "1.0.0" }, null, 2) + "\n");

	const skillMd = `---
name: ${name}
description: ${description}
---

${instructions}
`;
	writeFileSync(join(skillDir, "SKILL.md"), skillMd);

	clearSkillDirsCache();
	return `Skill '${name}' created at ${skillDir}. It will be available on your next message.`;
}

/** Remove a skill from the local skills directory (~/.nzb/skills/). */
export function removeSkill(slug: string): { ok: boolean; message: string } {
	const skillDir = join(LOCAL_SKILLS_DIR, slug);
	// Guard against path traversal — resolve to canonical path and verify it stays inside skills dir
	const resolvedSkillDir = resolve(skillDir);
	const resolvedBase = resolve(LOCAL_SKILLS_DIR);
	if (!resolvedSkillDir.startsWith(resolvedBase + sep)) {
		return { ok: false, message: `Invalid slug '${slug}': must be a simple kebab-case name without path separators.` };
	}
	if (!existsSync(skillDir)) {
		return { ok: false, message: `Skill '${slug}' not found in ${LOCAL_SKILLS_DIR}.` };
	}

	rmSync(skillDir, { recursive: true, force: true });
	clearSkillDirsCache();
	return {
		ok: true,
		message: `Skill '${slug}' removed from ${skillDir}. It will no longer be available on your next message.`,
	};
}

/** Parse YAML frontmatter from a SKILL.md file. */
function parseFrontmatter(content: string): { name: string; description: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { name: "", description: "" };

	const frontmatter = match[1];
	let name = "";
	let description = "";

	for (const line of frontmatter.split("\n")) {
		const idx = line.indexOf(": ");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 2).trim();
		if (key === "name") name = value;
		if (key === "description") description = value;
	}

	return { name, description };
}
