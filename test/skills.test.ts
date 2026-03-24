import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tempBase } = vi.hoisted(() => {
	const { mkdtempSync } = require("fs");
	const { tmpdir } = require("os");
	const { join } = require("path");
	const tempBase = mkdtempSync(join(tmpdir(), "nzb-skills-test-"));
	return { tempBase };
});

vi.mock("../src/paths.js", () => ({
	SKILLS_DIR: tempBase,
	NZB_HOME: tempBase,
	ensureNZBHome: vi.fn(),
}));

// Must import AFTER mocking
import {
	clearSkillDirsCache,
	createSkill,
	getSkillDirectories,
	listSkills,
	removeSkill,
} from "../src/copilot/skills.js";

afterEach(() => {
	clearSkillDirsCache();
});

describe("getSkillDirectories", () => {
	beforeEach(() => {
		clearSkillDirsCache();
	});

	it("returns an array", () => {
		const dirs = getSkillDirectories();
		expect(Array.isArray(dirs)).toBe(true);
	});

	it("caches result on second call", () => {
		const first = getSkillDirectories();
		const second = getSkillDirectories();
		expect(first).toBe(second);
	});

	it("clears cache with clearSkillDirsCache", () => {
		const first = getSkillDirectories();
		clearSkillDirsCache();
		const second = getSkillDirectories();
		// New array reference (re-scanned)
		expect(first).not.toBe(second);
	});
});

describe("createSkill", () => {
	const testSlug = "test-create-skill";
	const testDir = join(tempBase, testSlug);

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("creates a skill directory with SKILL.md and _meta.json", () => {
		const result = createSkill(testSlug, "Test Skill", "A test skill", "Do something useful.");
		expect(result).toContain("created at");
		expect(existsSync(join(testDir, "SKILL.md"))).toBe(true);
		expect(existsSync(join(testDir, "_meta.json"))).toBe(true);
	});

	it("SKILL.md has frontmatter with name and description", () => {
		createSkill(testSlug, "My Skill", "My description", "Instructions here.");
		const content = readFileSync(join(testDir, "SKILL.md"), "utf-8");
		expect(content).toContain("name: My Skill");
		expect(content).toContain("description: My description");
		expect(content).toContain("Instructions here.");
	});

	it("_meta.json has slug and version", () => {
		createSkill(testSlug, "Meta Test", "desc", "body");
		const meta = JSON.parse(readFileSync(join(testDir, "_meta.json"), "utf-8"));
		expect(meta.slug).toBe(testSlug);
		expect(meta.version).toBe("1.0.0");
	});

	it("rejects duplicate slug", () => {
		createSkill(testSlug, "First", "desc", "body");
		const result = createSkill(testSlug, "Second", "desc", "body");
		expect(result).toContain("already exists");
	});

	it("rejects path traversal slug", () => {
		const result = createSkill("../escape", "Bad", "desc", "body");
		expect(result).toContain("Invalid slug");
	});

	it("allows nested slugs that resolve inside base", () => {
		const result = createSkill("a/b", "Nested", "desc", "body");
		expect(result).toContain("created at");
	});
});

describe("removeSkill", () => {
	const testSlug = "test-remove-skill";
	const testDir = join(tempBase, testSlug);

	it("removes an existing skill", () => {
		createSkill(testSlug, "To Remove", "desc", "body");
		expect(existsSync(testDir)).toBe(true);

		const result = removeSkill(testSlug);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("removed");
		expect(existsSync(testDir)).toBe(false);
	});

	it("returns error for non-existent skill", () => {
		const result = removeSkill("nonexistent-skill-xyz");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("not found");
	});

	it("rejects path traversal slug", () => {
		const result = removeSkill("../escape");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Invalid slug");
	});
});

describe("listSkills", () => {
	const testSlug = "test-list-skill";
	const testDir = join(tempBase, testSlug);

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("returns an array of SkillInfo", () => {
		const skills = listSkills();
		expect(Array.isArray(skills)).toBe(true);
	});

	it("includes a newly created skill", () => {
		clearSkillDirsCache();
		createSkill(testSlug, "Listed Skill", "A skill to list", "Do things.");
		clearSkillDirsCache();
		const skills = listSkills();
		const found = skills.find((s) => s.slug === testSlug);
		expect(found).toBeDefined();
		expect(found!.name).toBe("Listed Skill");
		expect(found!.description).toBe("A skill to list");
	});

	it("reports source correctly for local skills", () => {
		clearSkillDirsCache();
		createSkill(testSlug, "Local Skill", "desc", "body");
		clearSkillDirsCache();
		const skills = listSkills();
		const found = skills.find((s) => s.slug === testSlug);
		expect(found?.source).toBe("local");
	});

	it("handles skill directory without SKILL.md", () => {
		const emptySlug = "empty-skill-dir";
		const emptyDir = join(tempBase, emptySlug);
		mkdirSync(emptyDir, { recursive: true });
		clearSkillDirsCache();
		const skills = listSkills();
		const found = skills.find((s) => s.slug === emptySlug);
		// Should not be listed if no SKILL.md
		expect(found).toBeUndefined();
		rmSync(emptyDir, { recursive: true, force: true });
	});

	it("handles SKILL.md without frontmatter", () => {
		const noFmSlug = "no-frontmatter";
		const noFmDir = join(tempBase, noFmSlug);
		mkdirSync(noFmDir, { recursive: true });
		writeFileSync(join(noFmDir, "SKILL.md"), "Just instructions, no frontmatter.");
		clearSkillDirsCache();
		const skills = listSkills();
		const found = skills.find((s) => s.slug === noFmSlug);
		expect(found).toBeDefined();
		// Falls back to slug as name
		expect(found!.name).toBe(noFmSlug);
		expect(found!.description).toBe("(no description)");
		rmSync(noFmDir, { recursive: true, force: true });
	});
});
