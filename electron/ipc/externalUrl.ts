const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/**
 * Whether a URL is safe to hand to shell.openExternal. Restricts to web and mail
 * schemes so a compromised or injected renderer cannot use the open-external-url
 * IPC channel to launch file:, smb:, javascript:, or arbitrary custom-protocol
 * handlers on the host.
 */
export function isAllowedExternalUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return ALLOWED_EXTERNAL_URL_PROTOCOLS.has(parsed.protocol);
}
