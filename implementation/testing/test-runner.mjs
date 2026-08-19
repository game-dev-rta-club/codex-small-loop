#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const implementationRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const SUITES = new Set(["shared", "darwin", "win32"]);
const SUITE_ORDER = new Map([
  ["shared", 0],
  ["darwin", 1],
  ["win32", 2],
]);

function runnerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function portablePath(value) {
  return value.replaceAll("\\", "/");
}

export function classifyTestFile(relativePath) {
  const portable = portablePath(relativePath);
  if (!portable.endsWith(".test.mjs") || !portable.includes("/tests/")) {
    return null;
  }
  if (portable.includes("/tests/darwin/")) return "darwin";
  if (portable.includes("/tests/win32/")) return "win32";
  return "shared";
}

async function collect(directory, root, results) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(filename, root, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = portablePath(path.relative(root, filename));
    const suite = classifyTestFile(relativePath);
    if (suite) results.push({ filename, relativePath, suite });
  }
}

export async function discoverTestFiles(root = implementationRoot) {
  const discovered = [];
  await collect(path.resolve(root), path.resolve(root), discovered);
  return discovered.sort((left, right) => (
    SUITE_ORDER.get(left.suite) - SUITE_ORDER.get(right.suite)
    || left.relativePath.localeCompare(right.relativePath)
  ));
}

export function selectTestFiles(discovered, suite, platform = process.platform) {
  if (!SUITES.has(suite)) {
    throw runnerError(
      "TEST_SUITE_INVALID",
      "Test suite must be shared, darwin, or win32.",
    );
  }
  if (suite !== "shared" && suite !== platform) {
    throw runnerError(
      "TEST_SUITE_PLATFORM_MISMATCH",
      `The ${suite} test suite cannot run on ${platform}.`,
    );
  }
  return discovered.filter(({ suite: fileSuite }) => (
    fileSuite === "shared" || (suite !== "shared" && fileSuite === suite)
  ));
}

export async function runTestSuite(suite, {
  platform = process.platform,
  root = implementationRoot,
  listOnly = false,
  spawnProcess = spawn,
} = {}) {
  const selected = selectTestFiles(
    await discoverTestFiles(root),
    suite,
    platform,
  );
  if (selected.length === 0) {
    throw runnerError("TEST_SUITE_EMPTY", `The ${suite} test suite is empty.`);
  }
  if (listOnly) return selected;
  const child = spawnProcess(
    process.execPath,
    ["--test", ...selected.map(({ filename }) => filename)],
    { shell: false, stdio: "inherit", windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(runnerError(
          "TEST_SUITE_INTERRUPTED",
          `The ${suite} test suite ended with ${signal}.`,
        ));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(args) {
  const listOnly = args.includes("--list");
  const positional = args.filter((value) => value !== "--list");
  if (positional.length !== 1 || args.length !== positional.length + Number(listOnly)) {
    throw runnerError(
      "TEST_RUNNER_USAGE",
      "Usage: node implementation/testing/test-runner.mjs <shared|darwin|win32> [--list]",
    );
  }
  const selected = await runTestSuite(positional[0], { listOnly });
  if (listOnly) {
    for (const { relativePath } of selected) process.stdout.write(`${relativePath}\n`);
    return 0;
  }
  return selected;
}

if (process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error.code ?? "TEST_RUNNER_FAILED"}: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
