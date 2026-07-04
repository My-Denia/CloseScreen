import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativePath: string) {
	return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("exporter annotation rendering path", () => {
	it("passes annotation regions through the MP4 FrameRenderer path", () => {
		const source = readSource("src/lib/exporter/videoExporter.ts");

		expect(source).toMatch(
			/new FrameRenderer\(\{[\s\S]*annotationRegions:\s*this\.config\.annotationRegions/,
		);
		expect(source).toMatch(/await renderer\.renderFrame\(/);
	});

	it("passes annotation regions through the GIF FrameRenderer path", () => {
		const source = readSource("src/lib/exporter/gifExporter.ts");

		expect(source).toMatch(
			/new FrameRenderer\(\{[\s\S]*annotationRegions:\s*this\.config\.annotationRegions/,
		);
		expect(source).toMatch(/const renderer = this\.renderer[\s\S]*await renderer\.renderFrame\(/);
	});

	it("renders annotation regions from FrameRenderer with renderAnnotations", () => {
		const source = readSource("src/lib/exporter/frameRenderer.ts");

		expect(source).toMatch(/import \{ renderAnnotations \} from "\.\/annotationRenderer"/);
		expect(source).toMatch(/this\.config\.annotationRegions[\s\S]*await renderAnnotations\(/);
	});
});
