import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnnotationRegion, BlurShape, BlurType } from "@/components/video-editor/types";
import { renderAnnotations } from "./annotationRenderer";

type PixelData = Uint8ClampedArray;

interface PathShape {
	kind: "rect" | "ellipse" | "polygon";
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	points?: Array<{ x: number; y: number }>;
}

class FakeCanvas {
	private internalWidth = 0;
	private internalHeight = 0;
	data: PixelData = new Uint8ClampedArray(0);
	readonly context = new FakeContext(this);

	get width() {
		return this.internalWidth;
	}

	set width(value: number) {
		this.internalWidth = Math.max(0, Math.floor(value));
		this.resize();
	}

	get height() {
		return this.internalHeight;
	}

	set height(value: number) {
		this.internalHeight = Math.max(0, Math.floor(value));
		this.resize();
	}

	getContext(type: "2d") {
		return type === "2d" ? this.context : null;
	}

	private resize() {
		this.data = new Uint8ClampedArray(this.internalWidth * this.internalHeight * 4);
	}
}

class FakeContext {
	fillStyle = "rgba(0, 0, 0, 1)";
	filter = "none";
	private currentPath: PathShape | null = null;
	private clipPath: PathShape | null = null;
	private readonly stack: Array<{ fillStyle: string; filter: string; clipPath: PathShape | null }> =
		[];

	constructor(readonly canvas: FakeCanvas) {}

	save() {
		this.stack.push({ fillStyle: this.fillStyle, filter: this.filter, clipPath: this.clipPath });
	}

	restore() {
		const state = this.stack.pop();
		if (!state) return;
		this.fillStyle = state.fillStyle;
		this.filter = state.filter;
		this.clipPath = state.clipPath;
	}

	beginPath() {
		this.currentPath = null;
	}

	rect(x: number, y: number, width: number, height: number) {
		this.currentPath = { kind: "rect", x, y, width, height };
	}

	ellipse(x: number, y: number, radiusX: number, radiusY: number) {
		this.currentPath = {
			kind: "ellipse",
			x: x - radiusX,
			y: y - radiusY,
			width: radiusX * 2,
			height: radiusY * 2,
		};
	}

	moveTo(x: number, y: number) {
		this.currentPath = { kind: "polygon", points: [{ x, y }] };
	}

	lineTo(x: number, y: number) {
		if (this.currentPath?.kind !== "polygon") return;
		this.currentPath.points?.push({ x, y });
	}

	closePath() {
		// The fake path is already closed by the polygon point list.
	}

	clip() {
		this.clipPath = this.currentPath;
	}

	clearRect(x: number, y: number, width: number, height: number) {
		forEachPixel(this.canvas, x, y, width, height, (offset) => {
			this.canvas.data[offset] = 0;
			this.canvas.data[offset + 1] = 0;
			this.canvas.data[offset + 2] = 0;
			this.canvas.data[offset + 3] = 0;
		});
	}

	drawImage(source: FakeCanvas, ...args: number[]) {
		const normalized =
			args.length === 8
				? {
						sx: args[0],
						sy: args[1],
						sw: args[2],
						sh: args[3],
						dx: args[4],
						dy: args[5],
						dw: args[6],
						dh: args[7],
					}
				: {
						sx: 0,
						sy: 0,
						sw: source.width,
						sh: source.height,
						dx: args[0],
						dy: args[1],
						dw: source.width,
						dh: source.height,
					};

		forEachPixel(
			this.canvas,
			normalized.dx,
			normalized.dy,
			normalized.dw,
			normalized.dh,
			(offset, x, y) => {
				if (!this.isInClip(x + 0.5, y + 0.5)) return;
				const srcX = Math.floor(normalized.sx + (x - normalized.dx));
				const srcY = Math.floor(normalized.sy + (y - normalized.dy));
				const pixel = this.filter.startsWith("blur(")
					? averageSourcePixel(source, srcX, srcY, 3)
					: getSourcePixel(source, srcX, srcY);
				this.canvas.data[offset] = pixel[0];
				this.canvas.data[offset + 1] = pixel[1];
				this.canvas.data[offset + 2] = pixel[2];
				this.canvas.data[offset + 3] = pixel[3];
			},
		);
	}

	getImageData(x: number, y: number, width: number, height: number) {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let row = 0; row < height; row++) {
			for (let col = 0; col < width; col++) {
				const source = pixelOffset(this.canvas, x + col, y + row);
				const target = (row * width + col) * 4;
				data[target] = this.canvas.data[source] ?? 0;
				data[target + 1] = this.canvas.data[source + 1] ?? 0;
				data[target + 2] = this.canvas.data[source + 2] ?? 0;
				data[target + 3] = this.canvas.data[source + 3] ?? 0;
			}
		}
		return { data, width, height } as ImageData;
	}

	putImageData(imageData: ImageData, x: number, y: number) {
		for (let row = 0; row < imageData.height; row++) {
			for (let col = 0; col < imageData.width; col++) {
				const source = (row * imageData.width + col) * 4;
				const target = pixelOffset(this.canvas, x + col, y + row);
				this.canvas.data[target] = imageData.data[source];
				this.canvas.data[target + 1] = imageData.data[source + 1];
				this.canvas.data[target + 2] = imageData.data[source + 2];
				this.canvas.data[target + 3] = imageData.data[source + 3];
			}
		}
	}

	fillRect(x: number, y: number, width: number, height: number) {
		const color = parseRgba(this.fillStyle);
		forEachPixel(this.canvas, x, y, width, height, (offset, px, py) => {
			if (!this.isInClip(px + 0.5, py + 0.5)) return;
			blendPixel(this.canvas.data, offset, color);
		});
	}

	private isInClip(x: number, y: number): boolean {
		if (!this.clipPath) return true;
		return shapeContains(this.clipPath, x, y);
	}
}

const originalCreateElement = document.createElement.bind(document);

beforeAll(() => {
	document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
		if (tagName.toLowerCase() === "canvas") {
			return new FakeCanvas() as unknown as HTMLCanvasElement;
		}
		return originalCreateElement(tagName, options);
	}) as typeof document.createElement;
});

afterAll(() => {
	document.createElement = originalCreateElement;
});

function pixelOffset(canvas: FakeCanvas, x: number, y: number) {
	return (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
}

function forEachPixel(
	canvas: FakeCanvas,
	x: number,
	y: number,
	width: number,
	height: number,
	visit: (offset: number, x: number, y: number) => void,
) {
	const startX = Math.max(0, Math.floor(x));
	const startY = Math.max(0, Math.floor(y));
	const endX = Math.min(canvas.width, Math.ceil(x + width));
	const endY = Math.min(canvas.height, Math.ceil(y + height));
	for (let py = startY; py < endY; py++) {
		for (let px = startX; px < endX; px++) {
			visit(pixelOffset(canvas, px, py), px, py);
		}
	}
}

function getSourcePixel(
	canvas: FakeCanvas,
	x: number,
	y: number,
): [number, number, number, number] {
	const px = Math.min(canvas.width - 1, Math.max(0, x));
	const py = Math.min(canvas.height - 1, Math.max(0, y));
	const offset = pixelOffset(canvas, px, py);
	return [
		canvas.data[offset] ?? 0,
		canvas.data[offset + 1] ?? 0,
		canvas.data[offset + 2] ?? 0,
		canvas.data[offset + 3] ?? 0,
	];
}

function averageSourcePixel(
	canvas: FakeCanvas,
	x: number,
	y: number,
	radius: number,
): [number, number, number, number] {
	let red = 0;
	let green = 0;
	let blue = 0;
	let alpha = 0;
	let count = 0;
	for (let py = y - radius; py <= y + radius; py++) {
		for (let px = x - radius; px <= x + radius; px++) {
			const pixel = getSourcePixel(canvas, px, py);
			red += pixel[0];
			green += pixel[1];
			blue += pixel[2];
			alpha += pixel[3];
			count++;
		}
	}
	return [
		Math.round(red / count),
		Math.round(green / count),
		Math.round(blue / count),
		Math.round(alpha / count),
	];
}

function parseRgba(value: string): [number, number, number, number] {
	const match = value.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/);
	if (!match) return [0, 0, 0, 1];
	return [
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
		Math.max(0, Math.min(1, Number(match[4]))),
	];
}

function blendPixel(
	data: PixelData,
	offset: number,
	[colorRed, colorGreen, colorBlue, alpha]: [number, number, number, number],
) {
	data[offset] = Math.round(data[offset] * (1 - alpha) + colorRed * alpha);
	data[offset + 1] = Math.round(data[offset + 1] * (1 - alpha) + colorGreen * alpha);
	data[offset + 2] = Math.round(data[offset + 2] * (1 - alpha) + colorBlue * alpha);
	data[offset + 3] = 255;
}

function shapeContains(shape: PathShape, x: number, y: number): boolean {
	if (shape.kind === "rect") {
		return (
			x >= (shape.x ?? 0) &&
			x <= (shape.x ?? 0) + (shape.width ?? 0) &&
			y >= (shape.y ?? 0) &&
			y <= (shape.y ?? 0) + (shape.height ?? 0)
		);
	}

	if (shape.kind === "ellipse") {
		const rx = (shape.width ?? 0) / 2;
		const ry = (shape.height ?? 0) / 2;
		const cx = (shape.x ?? 0) + rx;
		const cy = (shape.y ?? 0) + ry;
		if (rx <= 0 || ry <= 0) return false;
		return (x - cx) ** 2 / rx ** 2 + (y - cy) ** 2 / ry ** 2 <= 1;
	}

	const points = shape.points ?? [];
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const pi = points[i];
		const pj = points[j];
		if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) {
			inside = !inside;
		}
	}
	return inside;
}

function seedHighContrastFrame(canvas: FakeCanvas) {
	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			const offset = pixelOffset(canvas, x, y);
			const checker = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
			canvas.data[offset] = checker ? 240 : 20;
			canvas.data[offset + 1] = checker ? 30 : 220;
			canvas.data[offset + 2] = (x * 5 + y * 3) % 256;
			canvas.data[offset + 3] = 255;
		}
	}
}

function createBlurRegion(shape: BlurShape, type: BlurType): AnnotationRegion {
	return {
		id: `${type}-${shape}`,
		startMs: 0,
		endMs: 1000,
		type: "blur",
		content: "",
		position: { x: 25, y: 25 },
		size: { width: 50, height: 50 },
		style: {
			color: "#ffffff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: 1,
		blurData: {
			type,
			shape,
			color: "white",
			intensity: 8,
			blockSize: 10,
			freehandPoints: [
				{ x: 5, y: 10 },
				{ x: 90, y: 8 },
				{ x: 92, y: 88 },
				{ x: 8, y: 92 },
			],
		},
	};
}

function sampleMeanAbsoluteDelta(
	before: PixelData,
	after: PixelData,
	canvas: FakeCanvas,
	rect: { x: number; y: number; width: number; height: number },
) {
	let total = 0;
	let count = 0;
	forEachPixel(canvas, rect.x, rect.y, rect.width, rect.height, (offset) => {
		total += Math.abs(before[offset] - after[offset]);
		total += Math.abs(before[offset + 1] - after[offset + 1]);
		total += Math.abs(before[offset + 2] - after[offset + 2]);
		count += 3;
	});
	return count === 0 ? 0 : total / count;
}

describe("renderAnnotations blur export rendering", () => {
	it.each([
		["mosaic", "rectangle"],
		["mosaic", "oval"],
		["mosaic", "freehand"],
		["blur", "rectangle"],
		["blur", "oval"],
		["blur", "freehand"],
	] as const)("alters exported pixels for %s %s blur regions", async (type, shape) => {
		const canvas = new FakeCanvas();
		canvas.width = 80;
		canvas.height = 80;
		seedHighContrastFrame(canvas);
		const before = new Uint8ClampedArray(canvas.data);

		await renderAnnotations(
			canvas.context as unknown as CanvasRenderingContext2D,
			[createBlurRegion(shape, type)],
			canvas.width,
			canvas.height,
			500,
			1,
		);

		const insideDelta = sampleMeanAbsoluteDelta(before, canvas.data, canvas, {
			x: 38,
			y: 38,
			width: 8,
			height: 8,
		});
		const controlDelta = sampleMeanAbsoluteDelta(before, canvas.data, canvas, {
			x: 2,
			y: 2,
			width: 10,
			height: 10,
		});

		expect(insideDelta).toBeGreaterThan(8);
		expect(controlDelta).toBe(0);
	});
});
