#!/usr/bin/env node

// Copy this single file into another project's tools/ directory.
// It deliberately has no imports from the Small Loop checkout or Codex.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PACKAGE = "@game-dev-rta-club/small-loop";
export const PACKAGE_SPEC = `${PACKAGE}@^1.0.0`;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const BIN = "implementation/components/commands/small-loop.mjs";

// Resolve npm's JS entry point, including the official Windows Node layout.
// Never put forwarded CLI arguments or cache paths into a shell command.
export async function findNpmCli() {
  const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? "").split(path.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    const candidates = [path.join(directory, "node_modules/npm/bin/npm-cli.js")];
    try { candidates.push(await realpath(path.join(directory, "npm"))); } catch {}
    for (const candidate of candidates) {
      if (path.basename(candidate) === "npm-cli.js" && (await stat(candidate).catch(() => null))?.isFile()) return candidate;
    }
  }
  throw new Error("Node.js 24+ with npm is required to download Small Loop.");
}

async function installPackage(directory) {
  const npmCli = await findNpmCli();
  await writeFile(path.join(directory, "package.json"), '{"private":true}\n');
  await execFileAsync(process.execPath, [npmCli, "install", PACKAGE_SPEC,
    "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock=false", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=20000"], {
    cwd: directory, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

async function packageEntry(directory) {
  const root = path.join(directory, "node_modules", PACKAGE);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== PACKAGE || !/^1\.\d+\.\d+$/.test(manifest.version)
      || manifest.bin?.["small-loop"] !== BIN) throw new Error("Incompatible Small Loop package.");
  const entry = path.join(root, BIN);
  if (!(await stat(entry)).isFile()) throw new Error("Small Loop entry point is missing.");
  return entry;
}

async function publishState(cacheRoot, value) {
  const temporary = path.join(cacheRoot, `state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path.join(cacheRoot, "current.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ensureCli({
  cacheRoot = path.join(os.homedir(), ".cache", "small-loop", "cli-v1"),
  now = Date.now(),
  install = installPackage,
  warn = (message) => process.stderr.write(`Small Loop: ${message}\n`),
} = {}) {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  let previous;
  let previousEntry;
  try {
    const state = JSON.parse(await readFile(path.join(cacheRoot, "current.json"), "utf8"));
    if (!/^package-[a-zA-Z0-9-]+$/.test(state.directory)
        || !Number.isFinite(state.nextCheck)) throw new Error("Invalid cache state.");
    previousEntry = await packageEntry(path.join(cacheRoot, state.directory));
    previous = state;
  } catch { /* An incomplete cache is repaired through a fresh install. */ }
  if (previousEntry && now < previous.nextCheck && previous.nextCheck <= now + REFRESH_MS) return previousEntry;

  // Unique immutable directories let simultaneous invocations finish safely.
  // Never delete an older package that a concurrent command may be using.
  const staging = await mkdtemp(path.join(cacheRoot, "package-"));
  try {
    await install(staging);
    const entry = await packageEntry(staging);
    // A malformed or incomplete release must not replace the working cache.
    await execFileAsync(process.execPath, [entry, "--help"], { timeout: 10_000, windowsHide: true });
    await publishState(cacheRoot, { directory: path.basename(staging), nextCheck: now + REFRESH_MS });
    return entry;
  } catch {
    await rm(staging, { recursive: true, force: true });
    if (!previousEntry) throw new Error("Could not download Small Loop. Check npm/network access and that the CLI package has been published, then retry.");
    await publishState(cacheRoot, { ...previous, nextCheck: now + RETRY_MS }).catch(() => {});
    warn("Update unavailable; using the previously downloaded CLI. Will retry in one hour.");
    return previousEntry;
  }
}

export async function runBootstrap(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Small Loop requires Node.js 24 or newer.");
  const entry = await ensureCli();
  // Execute once. A Sonner/project failure is not an update failure and must
  // never trigger a fallback or a second invocation of a future mutating CLI.
  const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit", windowsHide: true });
  const signals = ["SIGINT", "SIGTERM"];
  const handlers = signals.map((signal) => () => child.kill(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runBootstrap(); }
  catch (error) { process.stderr.write(`Small Loop: ${error.message}\n`); process.exitCode = 1; }
}
