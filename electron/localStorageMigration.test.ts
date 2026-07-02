// Guards the migration key list against renderer drift. localStorageMigration.ts carries a fixed
// set of localStorage keys from the old file:// origin to app://; if that list falls out of sync
// with the keys the renderer actually reads/writes, upgraded users silently lose that setting and
// the run-once flag locks the loss in permanently. (This is exactly the bug Codex caught on PR #53:
// the two i18n keys are hyphenated — closescreen-locale, closescreen-system-language-prompt-seen —
// but the migration list had underscored them.)
//
// The renderer key modules pull in React/i18next and can't be imported into the main-process test
// env, so both sides are read from source text — which also means the test tracks the real keys even
// if they move between modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every module that owns a localStorage key the renderer persists.
const RENDERER_KEY_SOURCES = [
	"src/lib/userPreferences.ts", // PREFS_KEY
	"src/lib/customFonts.ts", // STORAGE_KEY
	"src/i18n/config.ts", // LOCALE_STORAGE_KEY
	"src/contexts/I18nContext.tsx", // SYSTEM_LANGUAGE_PROMPT_SEEN_KEY
];

// All app localStorage keys share the `closescreen` prefix (underscore or hyphen variants).
const KEY_LITERAL = /["'`](closescreen[-_][a-z0-9_-]+)["'`]/g;
const extractKeys = (source: string): string[] =>
	[...source.matchAll(KEY_LITERAL)].map((m) => m[1]);

describe("localStorage migration key coverage", () => {
	// Parse MIGRATION_KEYS from the array literal specifically, so a key that only appears in a
	// comment can't make a real omission look covered.
	const arrayMatch = read("electron/localStorageMigration.ts").match(
		/const MIGRATION_KEYS\s*=\s*\[([\s\S]*?)\]/,
	);
	const migrationKeys = arrayMatch ? extractKeys(arrayMatch[1]) : [];

	it("parses a non-empty MIGRATION_KEYS array", () => {
		expect(migrationKeys.length).toBeGreaterThan(0);
	});

	for (const rel of RENDERER_KEY_SOURCES) {
		it(`migrates every localStorage key defined in ${rel}`, () => {
			const rendererKeys = extractKeys(read(rel));
			// If this fails, the key moved/renamed — update RENDERER_KEY_SOURCES and MIGRATION_KEYS.
			expect(rendererKeys.length).toBeGreaterThan(0);
			for (const key of rendererKeys) {
				expect(migrationKeys).toContain(key);
			}
		});
	}
});
