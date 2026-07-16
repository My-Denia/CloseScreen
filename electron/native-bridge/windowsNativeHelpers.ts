import path from "node:path";

export type WindowsNativeBackend = "rust" | "legacy";
export type WindowsNativeEffectiveIdentity = WindowsNativeBackend | "custom" | "mixed";
export type WindowsNativeHelperKind = "capture" | "cursor";
export type WindowsNativeHelperSource = WindowsNativeBackend | "override";

export type ResolvedWindowsNativeHelper = {
	kind: WindowsNativeHelperKind;
	path: string;
	source: WindowsNativeHelperSource;
};

export type ResolvedWindowsNativeHelperPair = {
	requestedBackend: WindowsNativeBackend;
	effectiveIdentity: WindowsNativeEffectiveIdentity;
	capture: ResolvedWindowsNativeHelper;
	cursor: ResolvedWindowsNativeHelper;
};

export type WindowsNativeHelperResolutionContext = {
	appPath: string;
	arch: string;
	env: NodeJS.ProcessEnv;
	isExecutable: (candidate: string) => Promise<boolean>;
	isPackaged: boolean;
	platform: NodeJS.Platform;
	resourcesPath: string;
};

const BACKEND_ENV = "CLOSESCREEN_WINDOWS_CAPTURE_BACKEND";

const HELPER_NAMES: Record<WindowsNativeBackend, Record<WindowsNativeHelperKind, string>> = {
	rust: {
		capture: "wgc-capture.exe",
		cursor: "cursor-sampler.exe",
	},
	legacy: {
		capture: "wgc-capture-legacy.exe",
		cursor: "cursor-sampler-legacy.exe",
	},
};

const OVERRIDE_ENV: Record<WindowsNativeHelperKind, string> = {
	capture: "CLOSESCREEN_WGC_CAPTURE_EXE",
	cursor: "CLOSESCREEN_CURSOR_SAMPLER_EXE",
};

export class WindowsNativeHelperResolutionError extends Error {
	constructor(
		message: string,
		readonly code:
			| "invalid-backend"
			| "missing-helper"
			| "unsupported-architecture"
			| "unsupported-platform",
	) {
		super(message);
		this.name = "WindowsNativeHelperResolutionError";
	}
}

export function parseWindowsNativeBackend(value: string | undefined): WindowsNativeBackend {
	if (value === undefined) {
		return "rust";
	}
	if (value === "rust" || value === "legacy") {
		return value;
	}
	throw new WindowsNativeHelperResolutionError(
		`${BACKEND_ENV} must be exactly "rust" or "legacy"; received ${JSON.stringify(value)}.`,
		"invalid-backend",
	);
}

function resolveAppPath(context: WindowsNativeHelperResolutionContext, ...segments: string[]) {
	const resolved = path.join(context.appPath, ...segments);
	return context.isPackaged ? resolved.replace(/\.asar([/\\])/, ".asar.unpacked$1") : resolved;
}

function nativeBinPath(
	context: WindowsNativeHelperResolutionContext,
	backend: WindowsNativeBackend,
	kind: WindowsNativeHelperKind,
) {
	return path.join(
		context.isPackaged ? context.resourcesPath : context.appPath,
		"electron",
		"native",
		"bin",
		"win32-x64",
		HELPER_NAMES[backend][kind],
	);
}

export function getWindowsNativeHelperCandidates(
	context: WindowsNativeHelperResolutionContext,
	backend: WindowsNativeBackend,
	kind: WindowsNativeHelperKind,
): string[] {
	const overridePath = context.env[OVERRIDE_ENV[kind]]?.trim();
	if (overridePath) {
		return [overridePath];
	}

	const candidates: string[] = [];
	if (backend === "rust") {
		candidates.push(
			resolveAppPath(
				context,
				"electron",
				"native",
				"rust",
				"target",
				"dist",
				HELPER_NAMES.rust[kind],
			),
		);
	} else {
		candidates.push(
			resolveAppPath(
				context,
				"electron",
				"native",
				"wgc-capture",
				"build",
				"Release",
				kind === "capture" ? "wgc-capture.exe" : "cursor-sampler.exe",
			),
			resolveAppPath(
				context,
				"electron",
				"native",
				"wgc-capture",
				"build",
				kind === "capture" ? "wgc-capture.exe" : "cursor-sampler.exe",
			),
		);
	}

	candidates.push(nativeBinPath(context, backend, kind));
	return [...new Set(candidates)];
}

async function resolveHelper(
	context: WindowsNativeHelperResolutionContext,
	backend: WindowsNativeBackend,
	kind: WindowsNativeHelperKind,
): Promise<ResolvedWindowsNativeHelper> {
	const overridePath = context.env[OVERRIDE_ENV[kind]]?.trim();
	for (const candidate of getWindowsNativeHelperCandidates(context, backend, kind)) {
		if (await context.isExecutable(candidate)) {
			return {
				kind,
				path: candidate,
				source: overridePath ? "override" : backend,
			};
		}
	}

	const requested = overridePath
		? `${OVERRIDE_ENV[kind]}=${JSON.stringify(overridePath)}`
		: `${backend} ${kind} helper`;
	const nextStep =
		backend === "rust" && !overridePath
			? ` Set ${BACKEND_ENV}=legacy to use the packaged C++ rollback backend.`
			: " Build the selected helper pair or correct the diagnostic override.";
	throw new WindowsNativeHelperResolutionError(
		`The selected ${requested} is not available.${nextStep}`,
		"missing-helper",
	);
}

export async function resolveWindowsNativeHelperPair(
	context: WindowsNativeHelperResolutionContext,
): Promise<ResolvedWindowsNativeHelperPair> {
	const requestedBackend = parseWindowsNativeBackend(context.env[BACKEND_ENV]);
	if (context.platform !== "win32") {
		throw new WindowsNativeHelperResolutionError(
			"Windows native capture helpers are available only on Windows.",
			"unsupported-platform",
		);
	}
	if (context.arch !== "x64") {
		throw new WindowsNativeHelperResolutionError(
			`Windows native capture release payloads support x64 only; received ${context.arch}.`,
			"unsupported-architecture",
		);
	}

	const [capture, cursor] = await Promise.all([
		resolveHelper(context, requestedBackend, "capture"),
		resolveHelper(context, requestedBackend, "cursor"),
	]);
	const effectiveIdentity: WindowsNativeEffectiveIdentity =
		capture.source === "override" && cursor.source === "override"
			? "custom"
			: capture.source === "override" || cursor.source === "override"
				? "mixed"
				: requestedBackend;

	return {
		requestedBackend,
		effectiveIdentity,
		capture,
		cursor,
	};
}
