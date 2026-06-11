#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SOURCE_REPO = "siddharthvaddem/openscreen";
const DEFAULT_TARGET_REPO = "pjyqifei02/openscreen";
const MIGRATION_LABEL = "upstream-migration";

function printHelp() {
	console.log(`Usage:
  node scripts/migrate-upstream-issues.mjs [options]

Copies currently open upstream issues into the fork with source links.
Dry-run is the default. No GitHub writes happen unless --execute is passed.

Options:
  --source <owner/repo>   Source repo. Default: ${DEFAULT_SOURCE_REPO}
  --target <owner/repo>   Target repo. Default: ${DEFAULT_TARGET_REPO}
  --limit <n>             Maximum source issues to read. Default: 100
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
			options.sourceRepo = requireValue(argv, (index += 1), arg);
		} else if (arg === "--target") {
			options.targetRepo = requireValue(argv, (index += 1), arg);
		} else if (arg === "--limit") {
			const value = Number(requireValue(argv, (index += 1), arg));
			if (!Number.isInteger(value) || value <= 0) {
				throw new Error(`Invalid --limit value: ${argv[index]}`);
			}
			options.limit = value;
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

function buildMigratedBody(issue, sourceRepo) {
	const url = issue.url || sourceIssueUrl(sourceRepo, issue.number);
	const labels = (issue.labels ?? []).map(normalizeLabelName).filter(Boolean).join(", ");
	const originalBody = issue.body?.trim() || "_No upstream body._";

	return [
		`Migrated from upstream OpenScreen issue: ${url}`,
		"",
		`Source: ${sourceRepo}#${issue.number}`,
		labels ? `Upstream labels: ${labels}` : "Upstream labels: none",
		"",
		"---",
		"",
		originalBody,
		"",
		"<!-- upstream-migration-source: " + url + " -->",
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
		const match = body.match(
			/<!--\s*upstream-migration-source:\s*(https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)\s*-->/,
		);
		if (match) {
			sources.set(match[1], issue);
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
		const title = `[upstream #${issue.number}] ${issue.title}`;
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
