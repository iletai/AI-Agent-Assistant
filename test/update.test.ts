import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process and fs to isolate tests from real npm/filesystem
vi.mock("child_process", () => ({
	exec: vi.fn(),
	execSync: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		readFileSync: vi.fn((path: string, encoding?: string) => {
			if (typeof path === "string" && path.includes("package.json")) {
				return JSON.stringify({ name: "@iletai/nzb", version: "1.0.0" });
			}
			return (actual.readFileSync as Function)(path, encoding);
		}),
	};
});

import { exec, execSync } from "child_process";
import { checkForUpdate, getLatestVersion, performUpdate } from "../src/update.js";

describe("getLatestVersion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the version string on success", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "2.0.0", "");
			return {} as any;
		});

		const version = await getLatestVersion();
		expect(version).toBe("2.0.0");
	});

	it("returns null on error", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(new Error("network error"), "", "");
			return {} as any;
		});

		const version = await getLatestVersion();
		expect(version).toBeNull();
	});

	it("returns null on empty stdout", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "", "");
			return {} as any;
		});

		const version = await getLatestVersion();
		expect(version).toBeNull();
	});
});

describe("checkForUpdate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reports update available when remote is newer", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "2.0.0", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.current).toBe("1.0.0");
		expect(result.latest).toBe("2.0.0");
		expect(result.updateAvailable).toBe(true);
		expect(result.checkSucceeded).toBe(true);
	});

	it("reports no update when versions are equal", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "1.0.0", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.updateAvailable).toBe(false);
		expect(result.checkSucceeded).toBe(true);
	});

	it("reports no update when local is newer", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "0.9.0", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.updateAvailable).toBe(false);
	});

	it("handles check failure gracefully", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(new Error("timeout"), "", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.latest).toBeNull();
		expect(result.updateAvailable).toBe(false);
		expect(result.checkSucceeded).toBe(false);
	});

	it("detects major version bump", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "3.0.0", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.updateAvailable).toBe(true);
	});

	it("detects minor version bump", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "1.1.0", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.updateAvailable).toBe(true);
	});

	it("detects patch version bump", async () => {
		vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
			cb(null, "1.0.1", "");
			return {} as any;
		});

		const result = await checkForUpdate();
		expect(result.updateAvailable).toBe(true);
	});
});

describe("performUpdate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns ok on success", async () => {
		vi.mocked(execSync).mockReturnValue("Successfully installed @iletai/nzb@2.0.0");

		const result = await performUpdate();
		expect(result.ok).toBe(true);
		expect(result.output).toContain("Successfully installed");
	});

	it("returns error on failure", async () => {
		const error = new Error("Permission denied") as any;
		error.stderr = "EACCES: permission denied";
		vi.mocked(execSync).mockImplementation(() => {
			throw error;
		});

		const result = await performUpdate();
		expect(result.ok).toBe(false);
		expect(result.output).toContain("EACCES");
	});

	it("handles error without stderr", async () => {
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error("Unknown failure");
		});

		const result = await performUpdate();
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Unknown failure");
	});
});
