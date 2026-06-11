import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { DEFAULT_SHORTCUTS, mergeWithDefaults, type ShortcutsConfig } from "@/lib/shortcuts";

interface ShortcutsContextValue {
	shortcuts: ShortcutsConfig;
	setShortcuts: (config: ShortcutsConfig) => void;
	persistShortcuts: (config?: ShortcutsConfig) => Promise<boolean>;
	isConfigOpen: boolean;
	openConfig: () => void;
	closeConfig: () => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcuts(): ShortcutsContextValue {
	const ctx = useContext(ShortcutsContext);
	if (!ctx) throw new Error("useShortcuts must be used within <ShortcutsProvider>");
	return ctx;
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
	const [shortcuts, setShortcuts] = useState<ShortcutsConfig>(DEFAULT_SHORTCUTS);
	const [isConfigOpen, setIsConfigOpen] = useState(false);

	useEffect(() => {
		window.electronAPI
			.getShortcuts?.()
			.then((saved) => {
				if (saved) {
					setShortcuts(mergeWithDefaults(saved as Partial<ShortcutsConfig>));
				}
			})
			.catch(() => {
				// Keep default shortcuts if persisted settings can't be loaded.
			});
	}, []);

	const persistShortcuts = useCallback(
		async (config?: ShortcutsConfig) => {
			const configToSave = config ?? shortcuts;
			await window.electronAPI.saveShortcuts?.(configToSave);

			const result = await window.electronAPI.updateGlobalShortcut?.(configToSave.openApp);
			return result ? result.success : true;
		},
		[shortcuts],
	);

	const openConfig = useCallback(() => setIsConfigOpen(true), []);
	const closeConfig = useCallback(() => setIsConfigOpen(false), []);

	const value = useMemo<ShortcutsContextValue>(
		() => ({
			shortcuts,
			setShortcuts,
			persistShortcuts,
			isConfigOpen,
			openConfig,
			closeConfig,
		}),
		[shortcuts, persistShortcuts, isConfigOpen, openConfig, closeConfig],
	);

	return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
