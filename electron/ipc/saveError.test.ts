import { describe, expect, it } from "vitest";
import { describeSaveError } from "./saveError";

describe("describeSaveError", () => {
	const withCode = (code: string) => Object.assign(new Error(code), { code });

	it("maps permission errors to Controlled Folder Access guidance (the likely Windows cause)", () => {
		expect(describeSaveError(withCode("EACCES"))).toMatch(/Permission denied/);
		expect(describeSaveError(withCode("EPERM"))).toMatch(/Controlled Folder Access/);
	});

	it("maps a full disk", () => {
		expect(describeSaveError(withCode("ENOSPC"))).toMatch(/disk space/);
	});

	it("maps a locked/in-use file", () => {
		expect(describeSaveError(withCode("EBUSY"))).toMatch(/in use by another program/);
	});

	it("maps missing folder, over-long path, and read-only target", () => {
		expect(describeSaveError(withCode("ENOENT"))).toMatch(/no longer exists/);
		expect(describeSaveError(withCode("ENAMETOOLONG"))).toMatch(/too long/);
		expect(describeSaveError(withCode("EROFS"))).toMatch(/read-only/);
	});

	it("includes the raw code for unmapped errors so the next report is actionable", () => {
		expect(describeSaveError(withCode("ESOMETHING"))).toBe(
			"Failed to save exported video (ESOMETHING).",
		);
	});

	it("degrades to the generic message when there is no error code", () => {
		expect(describeSaveError(new Error("boom"))).toBe("Failed to save exported video.");
		expect(describeSaveError("weird")).toBe("Failed to save exported video.");
		expect(describeSaveError(null)).toBe("Failed to save exported video.");
		expect(describeSaveError(undefined)).toBe("Failed to save exported video.");
	});
});
