import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import { DEFAULT_SHORTCUTS, mergeWithDefaults, type ShortcutBinding } from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

// Maps KeyboardEvent.key values to Electron accelerator key names
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	"-": "numsub",
	"*": "nummult",
	"/": "numdiv",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const acceleratorKey = KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase();
	parts.push(acceleratorKey);

	return parts.join("+");
}

let currentAccelerator: string | null = null;

export function registerOpenAppShortcut(binding: ShortcutBinding, onTrigger: () => void): boolean {
	const accelerator = bindingToAccelerator(binding);

	if (accelerator === currentAccelerator) {
		return true;
	}

	// Register the new shortcut before unregistering the old, so a failure leaves the old binding intact
	const success = globalShortcut.register(accelerator, onTrigger);

	if (success) {
		if (currentAccelerator) {
			globalShortcut.unregister(currentAccelerator);
		}
		currentAccelerator = accelerator;
		console.log(`Global shortcut registered: ${accelerator}`);
	} else {
		console.warn(`Failed to register global shortcut: ${accelerator}`);
	}

	return success;
}

export async function loadAndRegisterGlobalShortcut(onTrigger: () => void): Promise<void> {
	try {
		const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
		// Run the persisted config through the same sanitizer the renderer uses, so a stored
		// openApp binding that is now reserved (e.g. Ctrl+C after #54) never gets registered
		// as the OS-global hotkey while the UI shows the remapped default.
		const binding = mergeWithDefaults(JSON.parse(data)).openApp;
		registerOpenAppShortcut(binding, onTrigger);
	} catch {
		registerOpenAppShortcut(DEFAULT_SHORTCUTS.openApp, onTrigger);
	}
}

export function unregisterAllGlobalShortcuts(): void {
	globalShortcut.unregisterAll();
}
