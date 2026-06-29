import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./externalUrl";

describe("isAllowedExternalUrl", () => {
	it("allows https, http and mailto", () => {
		expect(isAllowedExternalUrl("https://github.com/My-Denia/CloseScreen")).toBe(true);
		expect(isAllowedExternalUrl("http://example.com/path")).toBe(true);
		expect(isAllowedExternalUrl("mailto:dev@example.com")).toBe(true);
	});

	it("rejects file, smb, javascript and custom-protocol URLs", () => {
		expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
		expect(isAllowedExternalUrl("smb://host/share")).toBe(false);
		expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
		expect(isAllowedExternalUrl("vscode://file/etc")).toBe(false);
	});

	it("rejects malformed or empty input", () => {
		expect(isAllowedExternalUrl("not a url")).toBe(false);
		expect(isAllowedExternalUrl("")).toBe(false);
	});
});
