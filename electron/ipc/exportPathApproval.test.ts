import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExportPathApprovals, normalizeExportPath } from "./exportPathApproval";

const root = path.parse(path.resolve(process.cwd())).root;
const exportPath = (...segments: string[]) =>
	path.join(root, "closescreen-export-test", ...segments);

describe("normalizeExportPath", () => {
	it("normalizes absolute mp4 and gif paths", () => {
		expect(normalizeExportPath(exportPath("nested", "..", "clip.mp4"))).toBe(
			exportPath("clip.mp4"),
		);
		expect(normalizeExportPath(exportPath("clip.gif"))).toBe(exportPath("clip.gif"));
	});

	it("rejects relative, empty, non-string and non-export paths", () => {
		expect(normalizeExportPath("relative.mp4")).toBeNull();
		expect(normalizeExportPath("")).toBeNull();
		expect(normalizeExportPath(` ${exportPath("clip.mp4")} `)).toBeNull();
		expect(normalizeExportPath(null)).toBeNull();
		expect(normalizeExportPath(exportPath("clip.webm"))).toBeNull();
	});
});

describe("ExportPathApprovals", () => {
	it("allows an approved normalized export path exactly once", () => {
		const approvals = new ExportPathApprovals();
		const approved = approvals.approve(exportPath("take.mp4"));

		expect(approved).toBe(exportPath("take.mp4"));
		expect(approvals.consume(exportPath("take.mp4"))).toBe(exportPath("take.mp4"));
		expect(approvals.consume(exportPath("take.mp4"))).toBeNull();
	});

	it("rejects an unapproved export path", () => {
		const approvals = new ExportPathApprovals();

		expect(approvals.consume(exportPath("never-approved.mp4"))).toBeNull();
	});

	it("matches path-equivalent spellings after normalization", () => {
		const approvals = new ExportPathApprovals();

		expect(approvals.approve(exportPath("folder", "..", "normalized.gif"))).toBe(
			exportPath("normalized.gif"),
		);
		expect(approvals.consume(exportPath("normalized.gif"))).toBe(exportPath("normalized.gif"));
	});

	it("does not let one approved path write a different export path", () => {
		const approvals = new ExportPathApprovals();
		approvals.approve(exportPath("approved.mp4"));

		expect(approvals.consume(exportPath("different.mp4"))).toBeNull();
		expect(approvals.consume(exportPath("approved.mp4"))).toBe(exportPath("approved.mp4"));
	});

	it("does not approve invalid extensions", () => {
		const approvals = new ExportPathApprovals();

		expect(approvals.approve(exportPath("not-export.txt"))).toBeNull();
		expect(approvals.consume(exportPath("not-export.txt"))).toBeNull();
	});

	it("expires abandoned approvals", () => {
		let now = 1_000;
		const approvals = new ExportPathApprovals(() => now, 500);
		approvals.approve(exportPath("abandoned.mp4"));

		now += 500;

		expect(approvals.consume(exportPath("abandoned.mp4"))).toBeNull();
	});

	it("discards an approved path when export is abandoned", () => {
		const approvals = new ExportPathApprovals();
		approvals.approve(exportPath("canceled.gif"));

		expect(approvals.discard(exportPath("canceled.gif"))).toBe(true);
		expect(approvals.consume(exportPath("canceled.gif"))).toBeNull();
	});
});
