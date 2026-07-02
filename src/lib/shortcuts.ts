export const SHORTCUT_ACTIONS = [
	"openApp",
	"addZoom",
	"addTrim",
	"addSpeed",
	"addAnnotation",
	"addBlur",
	"addHighlight",
	"addKeyframe",
	"deleteSelected",
	"playPause",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export interface ShortcutBinding {
	key: string;
	/** Primary keyboard modifier. */
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>;

export interface FixedShortcut {
	i18nKey: string;
	label: string;
	display: string;
	bindings: ShortcutBinding[];
}

export const FIXED_SHORTCUTS: FixedShortcut[] = [
	{ i18nKey: "undo", label: "Undo", display: "Ctrl + Z", bindings: [{ key: "z", ctrl: true }] },
	{
		i18nKey: "redo",
		label: "Redo",
		display: "Ctrl + Shift + Z / Ctrl + Y",
		bindings: [
			{ key: "z", ctrl: true, shift: true },
			{ key: "y", ctrl: true },
		],
	},
	{
		i18nKey: "cycleAnnotationsForward",
		label: "Cycle Annotations Forward",
		display: "Tab",
		bindings: [{ key: "tab" }],
	},
	{
		i18nKey: "cycleAnnotationsBackward",
		label: "Cycle Annotations Backward",
		display: "Shift + Tab",
		bindings: [{ key: "tab", shift: true }],
	},
	{
		i18nKey: "deleteSelectedAlt",
		label: "Delete Selected (alt)",
		display: "Del / ⌫",
		bindings: [{ key: "delete" }, { key: "backspace" }],
	},
	{
		i18nKey: "panTimeline",
		label: "Pan Timeline",
		display: "Shift + Ctrl + Scroll",
		bindings: [],
	},
	{ i18nKey: "zoomTimeline", label: "Zoom Timeline", display: "Ctrl + Scroll", bindings: [] },
	// Timeline clipboard (issue #29). Listed here so the customize dialog reserves the
	// bindings — TimelineEditor handles these keys directly, so letting a configurable
	// action claim Ctrl+C/V would behave inconsistently with selection/clipboard state.
	{
		i18nKey: "copyTimelineItem",
		label: "Copy Selected Element",
		display: "Ctrl + C",
		bindings: [{ key: "c", ctrl: true }],
	},
	{
		i18nKey: "pasteTimelineItem",
		label: "Paste at Playhead",
		display: "Ctrl + V",
		bindings: [{ key: "v", ctrl: true }],
	},
	{ i18nKey: "frameBack", label: "Frame Back", display: "←", bindings: [{ key: "arrowleft" }] },
	{
		i18nKey: "frameForward",
		label: "Frame Forward",
		display: "→",
		bindings: [{ key: "arrowright" }],
	},
];

export type ShortcutConflict =
	| { type: "configurable"; action: ShortcutAction }
	| { type: "fixed"; label: string };

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		!!a.ctrl === !!b.ctrl &&
		!!a.shift === !!b.shift &&
		!!a.alt === !!b.alt
	);
}

export function findConflict(
	binding: ShortcutBinding,
	forAction: ShortcutAction,
	config: ShortcutsConfig,
): ShortcutConflict | null {
	for (const fixed of FIXED_SHORTCUTS) {
		if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
			return { type: "fixed", label: fixed.label };
		}
	}
	for (const action of SHORTCUT_ACTIONS) {
		if (action !== forAction && bindingsEqual(config[action], binding)) {
			return { type: "configurable", action };
		}
	}
	return null;
}

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
	openApp: { key: "o", ctrl: true, shift: true },
	addZoom: { key: "z" },
	addTrim: { key: "t" },
	addSpeed: { key: "s" },
	addAnnotation: { key: "a" },
	addBlur: { key: "b" },
	addHighlight: { key: "h" },
	addKeyframe: { key: "f" },
	deleteSelected: { key: "d", ctrl: true },
	playPause: { key: " " },
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	openApp: "Open App",
	addZoom: "Add Zoom",
	addTrim: "Add Trim",
	addSpeed: "Add Speed",
	addAnnotation: "Add Annotation",
	addBlur: "Add Blur",
	addHighlight: "Add Cursor Highlight",
	addKeyframe: "Add Keyframe",
	deleteSelected: "Delete Selected",
	playPause: "Play / Pause",
};

export function matchesShortcut(e: KeyboardEvent, binding: ShortcutBinding | undefined): boolean {
	if (!binding) return false;
	if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;

	const primaryMod = e.ctrlKey;
	if (primaryMod !== !!binding.ctrl) return false;
	if (e.shiftKey !== !!binding.shift) return false;
	if (e.altKey !== !!binding.alt) return false;

	return true;
}

const KEY_LABELS: Record<string, string> = {
	" ": "Space",
	delete: "Del",
	backspace: "⌫",
	escape: "Esc",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
};

export function formatBinding(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("Ctrl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}

export function mergeWithDefaults(partial: Partial<ShortcutsConfig>): ShortcutsConfig {
	const merged = { ...DEFAULT_SHORTCUTS };
	for (const action of SHORTCUT_ACTIONS) {
		const saved = partial[action];
		if (!saved) continue;
		// A saved binding can predate an entry in FIXED_SHORTCUTS (e.g. Ctrl+C/V, reserved for
		// the timeline clipboard in #54). The dialog blocks new assignments, but a stale stored
		// one would be silently shadowed by the hard-coded handler and shown as a duplicate
		// claim in the shortcuts UI — so remap it to the action's default on load.
		const reservedByFixed = FIXED_SHORTCUTS.some((fixed) =>
			fixed.bindings.some((binding) => bindingsEqual(binding, saved)),
		);
		merged[action] = reservedByFixed ? DEFAULT_SHORTCUTS[action] : saved;
	}

	// Falling back to a default can itself duplicate another action's legitimately saved
	// binding (e.g. addZoom: Ctrl+C → default Z while addTrim was swapped onto Z). Resolve by
	// resetting whichever colliding action is NOT on its own default to its default, repeating
	// until stable. Defaults are pairwise distinct, so every reset strictly shrinks the set of
	// off-default actions and the loop terminates with no duplicates.
	for (let changed = true; changed; ) {
		changed = false;
		for (const a of SHORTCUT_ACTIONS) {
			for (const b of SHORTCUT_ACTIONS) {
				if (a === b || !bindingsEqual(merged[a], merged[b])) continue;
				const victim =
					bindingsEqual(merged[b], DEFAULT_SHORTCUTS[b]) &&
					!bindingsEqual(merged[a], DEFAULT_SHORTCUTS[a])
						? a
						: b;
				merged[victim] = DEFAULT_SHORTCUTS[victim];
				changed = true;
			}
		}
	}
	return merged;
}
