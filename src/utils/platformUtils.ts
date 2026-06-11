let cachedPlatform: string | null = null;

/**
 * Gets the current platform from Electron
 */
export const getPlatform = async (): Promise<string> => {
	if (cachedPlatform) return cachedPlatform;

	try {
		const platform = await window.electronAPI.getPlatform();
		cachedPlatform = platform;
		return platform;
	} catch (error) {
		console.warn("Failed to get platform from Electron, falling back to navigator:", error);
		// Fallback for dev/testing
		let fallbackPlatform = "win32";
		if (typeof navigator !== "undefined") {
			if (/Linux/.test(navigator.platform)) {
				fallbackPlatform = "linux";
			}
		}

		cachedPlatform = fallbackPlatform;
		return fallbackPlatform;
	}
};

/**
 * Gets the modifier key symbol based on the platform
 */
export const getModifierKey = async (): Promise<string> => {
	return "Ctrl";
};

/**
 * Gets the shift key symbol based on the platform
 */
export const getShiftKey = async (): Promise<string> => {
	return "Shift";
};

/**
 * Formats a keyboard shortcut for display based on the platform
 * @param keys Array of key combinations (e.g., ['mod', 'D'] or ['shift', 'mod', 'Scroll'])
 */
export const formatShortcut = async (keys: string[]): Promise<string> => {
	return keys
		.map((key) => {
			if (key.toLowerCase() === "mod") return "Ctrl";
			if (key.toLowerCase() === "shift") return "Shift";
			return key;
		})
		.join(" + ");
};
