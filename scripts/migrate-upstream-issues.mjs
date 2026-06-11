#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SOURCE_REPO = "siddharthvaddem/openscreen";
const DEFAULT_TARGET_REPO = "My-Denia/openscreen";
const MIGRATION_LABEL = "upstream-migration";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function printHelp() {
	console.log(`Usage:
  node scripts/migrate-upstream-issues.mjs [options]

Copies currently open upstream issues into the fork with source links.
Dry-run is the default. No GitHub writes happen unless --execute is passed.

Options:
  --source <owner/repo>   Source repo. Default: ${DEFAULT_SOURCE_REPO}
  --target <owner/repo>   Target repo. Default: ${DEFAULT_TARGET_REPO}
  --limit <n>             Maximum source issues to read. Default: 100
  --sample-body [number]  In dry-run mode, print one sanitized body preview.
  --execute               Create missing migrated issues in the target repo.
  --help                  Show this help.

Review flow:
  1. gh auth login
  2. node scripts/migrate-upstream-issues.mjs
  3. Review the dry-run list.
  4. node scripts/migrate-upstream-issues.mjs --execute
`);
}

function parseArgs(argv) {
	const options = {
		sourceRepo: DEFAULT_SOURCE_REPO,
		targetRepo: DEFAULT_TARGET_REPO,
		limit: 100,
		sampleBody: false,
		sampleIssueNumber: undefined,
		execute: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--execute") {
			options.execute = true;
		} else if (arg === "--source") {
			index += 1;
			options.sourceRepo = requireValue(argv, index, arg);
		} else if (arg === "--target") {
			index += 1;
			options.targetRepo = requireValue(argv, index, arg);
		} else if (arg === "--limit") {
			index += 1;
			const value = Number(requireValue(argv, index, arg));
			if (!Number.isInteger(value) || value <= 0) {
				throw new Error(`Invalid --limit value: ${argv[index]}`);
			}
			options.limit = value;
		} else if (arg === "--sample-body") {
			options.sampleBody = true;
			const next = argv[index + 1];
			if (next && !next.startsWith("--")) {
				const value = Number(next);
				if (!Number.isInteger(value) || value <= 0) {
					throw new Error(`Invalid --sample-body value: ${next}`);
				}
				options.sampleIssueNumber = value;
				index += 1;
			}
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function requireValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value.`);
	}
	return value;
}

function gh(args, options = {}) {
	const result = spawnSync("gh", args, {
		encoding: "utf8",
		input: options.input,
		maxBuffer: 64 * 1024 * 1024,
	});

	if (result.error) {
		throw new Error(`Failed to run gh: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			[
				`gh ${args.join(" ")} failed with exit code ${result.status}.`,
				result.stdout.trim(),
				result.stderr.trim(),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	return result.stdout;
}

function readJsonFromGh(args) {
	const raw = gh(args);
	return raw.trim() ? JSON.parse(raw) : [];
}

function normalizeLabelName(label) {
	return typeof label === "string" ? label : label?.name;
}

function sourceIssueUrl(sourceRepo, number) {
	return `https://github.com/${sourceRepo}/issues/${number}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeSpan(value) {
	return `\`${value}\``;
}

function sanitizeMentions(value) {
	return value.replace(
		/(^|[^A-Za-z0-9_`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)?)/g,
		(_match, prefix, mention) => `${prefix}@${ZERO_WIDTH_SPACE}${mention}`,
	);
}

function sanitizeUpstreamIssueLinks(value, sourceRepo) {
	const upstreamIssueUrlPattern = new RegExp(
		`https://github\\.com/${escapeRegExp(sourceRepo)}/issues/\\d+`,
		"g",
	);
	return value.replace(upstreamIssueUrlPattern, (url, offset, fullText) => {
		const previous = fullText[offset - 1];
		const next = fullText[offset + url.length];
		if (previous === "`" && next === "`") {
			return url;
		}
		return codeSpan(url);
	});
}

function sanitizeCopiedText(value, sourceRepo) {
	return sanitizeMentions(sanitizeUpstreamIssueLinks(value, sourceRepo));
}

function buildMigratedBody(issue, sourceRepo) {
	const url = issue.url || sourceIssueUrl(sourceRepo, issue.number);
	const labels = (issue.labels ?? [])
		.map(normalizeLabelName)
		.filter(Boolean)
		.map((label) => sanitizeCopiedText(label, sourceRepo))
		.join(", ");
	const originalBody = sanitizeCopiedText(issue.body?.trim() || "_No upstream body._", sourceRepo);

	return [
		`Migrated from upstream OpenScreen issue: ${codeSpan(url)}`,
		"",
		`Source: ${codeSpan(`${sourceRepo}#${issue.number}`)}`,
		labels ? `Upstream labels: ${labels}` : "Upstream labels: none",
		"",
		"---",
		"",
		originalBody,
		"",
		"<!-- upstream-migration-source: " + sourceRepo + "#" + issue.number + " -->",
	].join("\n");
}

function ensureMigrationLabel(targetRepo) {
	const labels = readJsonFromGh([
		"label",
		"list",
		"--repo",
		targetRepo,
		"--limit",
		"1000",
		"--json",
		"name",
	]);
	if (labels.some((label) => label.name === MIGRATION_LABEL)) {
		return;
	}

	gh([
		"label",
		"create",
		MIGRATION_LABEL,
		"--repo",
		targetRepo,
		"--description",
		"Issues imported from the archived upstream OpenScreen repository",
		"--color",
		"5319e7",
	]);
}

function existingMigrationSources(targetRepo) {
	const issues = readJsonFromGh([
		"issue",
		"list",
		"--repo",
		targetRepo,
		"--state",
		"all",
		"--limit",
		"500",
		"--json",
		"number,title,body,url,labels",
	]);

	const sources = new Map();
	for (const issue of issues) {
		const body = issue.body ?? "";
		const legacyUrlMatch = body.match(
			/<!--\s*upstream-migration-source:\s*(https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)\s*-->/,
		);
		if (legacyUrlMatch) {
			sources.set(legacyUrlMatch[1], issue);
			continue;
		}

		const sourceRefMatch = body.match(
			/<!--\s*upstream-migration-source:\s*([^/\s]+\/[^#\s]+)#(\d+)\s*-->/,
		);
		if (sourceRefMatch) {
			sources.set(sourceIssueUrl(`${sourceRefMatch[1]}`, Number(sourceRefMatch[2])), issue);
			continue;
		}

		const codeSpanUrlMatch = body.match(/`(https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)`/);
		if (codeSpanUrlMatch) {
			sources.set(codeSpanUrlMatch[1], issue);
		}
	}
	return sources;
}

function createMigratedIssue(issue, options) {
	const body = buildMigratedBody(issue, options.sourceRepo);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-issue-migration-"));
	const bodyPath = path.join(tempDir, `issue-${issue.number}.md`);
	fs.writeFileSync(bodyPath, body, "utf8");

	try {
		const title = sanitizeMentions(`[upstream #${issue.number}] ${issue.title}`);
		gh([
			"issue",
			"create",
			"--repo",
			options.targetRepo,
			"--title",
			title,
			"--body-file",
			bodyPath,
			"--label",
			MIGRATION_LABEL,
		]);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	gh(["--version"]);

	const sourceIssues = readJsonFromGh([
		"issue",
		"list",
		"--repo",
		options.sourceRepo,
		"--state",
		"open",
		"--limit",
		String(options.limit),
		"--json",
		"number,title,body,url,labels",
	]);

	let existingSources;
	try {
		existingSources = existingMigrationSources(options.targetRepo);
	} catch (error) {
		if (options.execute) {
			throw error;
		}
		console.warn(
			`Warning: could not read existing target issues; dry-run will show all source issues as pending.\n${error instanceof Error ? error.message : String(error)}`,
		);
		existingSources = new Map();
	}
	const toCreate = sourceIssues.filter((issue) => {
		const url = issue.url || sourceIssueUrl(options.sourceRepo, issue.number);
		return !existingSources.has(url);
	});

	console.log(`Source repo: ${options.sourceRepo}`);
	console.log(`Target repo: ${options.targetRepo}`);
	console.log(`Open upstream issues read: ${sourceIssues.length}`);
	console.log(`Existing migrated issues detected: ${existingSources.size}`);
	console.log(`Issues to create: ${toCreate.length}`);
	console.log(`Mode: ${options.execute ? "EXECUTE" : "DRY RUN"}`);
	console.log("");

	for (const issue of toCreate) {
		const url = issue.url || sourceIssueUrl(options.sourceRepo, issue.number);
		console.log(`- #${issue.number}: ${issue.title}`);
		console.log(`  ${url}`);
	}

	if (!options.execute) {
		if (options.sampleBody) {
			const sampleIssue =
				toCreate.find((issue) => issue.number === options.sampleIssueNumber) ?? toCreate[0];
			console.log("");
			if (sampleIssue) {
				console.log(`Sanitized dry-run body sample for upstream #${sampleIssue.number}:`);
				console.log("-----BEGIN SANITIZED BODY-----");
				console.log(buildMigratedBody(sampleIssue, options.sourceRepo));
				console.log("-----END SANITIZED BODY-----");
			} else {
				console.log("Sanitized dry-run body sample: no pending issue available.");
			}
		}
		console.log("");
		console.log("Dry run only. Re-run with --execute after maintainer review to create issues.");
		return;
	}

	ensureMigrationLabel(options.targetRepo);
	for (const issue of toCreate) {
		createMigratedIssue(issue, options);
		console.log(`Created migrated issue for upstream #${issue.number}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
