// Renderer side of the update check (issues #17/#27): toasts + per-user notification
// preferences. The actual GitHub query runs in the main process (see
// electron/ipc/updateCheck.ts) because the packaged renderer's CSP has no remote
// connect-src. Strings come from the caller's `common`-scoped translator so this stays
// hook-free and usable from both the HUD startup path and the editor's settings button.
import { toast } from "sonner";

const DISMISSED_VERSION_KEY = "closescreen_update_dismissed_version";
const CHECKS_DISABLED_KEY = "closescreen_update_checks_disabled";

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export function getUpdateChecksDisabled(): boolean {
	try {
		return localStorage.getItem(CHECKS_DISABLED_KEY) === "1";
	} catch {
		return false;
	}
}

export function setUpdateChecksDisabled(disabled: boolean): void {
	try {
		if (disabled) {
			localStorage.setItem(CHECKS_DISABLED_KEY, "1");
		} else {
			localStorage.removeItem(CHECKS_DISABLED_KEY);
		}
	} catch {
		// localStorage may be unavailable; worst case the user is reminded again.
	}
}

export function getDismissedUpdateVersion(): string | null {
	try {
		return localStorage.getItem(DISMISSED_VERSION_KEY);
	} catch {
		return null;
	}
}

export function saveDismissedUpdateVersion(version: string): void {
	try {
		localStorage.setItem(DISMISSED_VERSION_KEY, version);
	} catch {
		// Same degradation as above.
	}
}

type UpdateCheckResult = Awaited<ReturnType<Window["electronAPI"]["checkForUpdates"]>>;

function showUpdateAvailableToast(
	result: Extract<UpdateCheckResult, { status: "update" }>,
	t: TranslateFn,
): void {
	toast(t("updates.availableTitle", { version: result.latestVersion }), {
		description: t("updates.availableDescription", { current: result.currentVersion }),
		duration: Number.POSITIVE_INFINITY,
		closeButton: true,
		onDismiss: () => saveDismissedUpdateVersion(result.latestVersion),
		action: {
			label: t("updates.download"),
			onClick: () => {
				void window.electronAPI.openExternalUrl(result.url);
			},
		},
		cancel: {
			label: t("updates.dontRemind"),
			onClick: () => setUpdateChecksDisabled(true),
		},
	});
}

/**
 * Startup check (#27): silent unless a newer, not-yet-dismissed release exists and the
 * user hasn't opted out.
 */
export async function runStartupUpdateCheck(t: TranslateFn): Promise<void> {
	if (getUpdateChecksDisabled()) return;
	let result: UpdateCheckResult;
	try {
		result = await window.electronAPI.checkForUpdates();
	} catch {
		return;
	}
	if (result.status !== "update") return;
	if (getDismissedUpdateVersion() === result.latestVersion) return;
	showUpdateAvailableToast(result, t);
}

/**
 * Manual check (#17): the user asked, so always answer — up-to-date and failure get a
 * toast too, and a previous dismissal doesn't suppress the result.
 */
export async function runManualUpdateCheck(t: TranslateFn): Promise<void> {
	let result: UpdateCheckResult;
	try {
		result = await window.electronAPI.checkForUpdates();
	} catch {
		result = { status: "error", currentVersion: "" };
	}
	if (result.status === "update") {
		showUpdateAvailableToast(result, t);
		return;
	}
	if (result.status === "upToDate") {
		toast.success(t("updates.upToDate"), {
			description: t("updates.upToDateDescription", { current: result.currentVersion }),
		});
		return;
	}
	toast.error(t("updates.checkFailed"), {
		description: t("updates.checkFailedDescription"),
	});
}
