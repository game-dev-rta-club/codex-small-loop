import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sourcePlugin = path.join(repositoryRoot, "implementation");

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

test("the copied plugin runs from an installed path containing spaces", async (t) => {
  const temporary = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-plugin-smoke-"),
  ));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const installedRoot = path.join(temporary, "Installed Plugin With Spaces");
  const projectRoot = path.join(temporary, "Project With Spaces");
  await Promise.all([
    cp(sourcePlugin, installedRoot, { recursive: true }),
    mkdir(projectRoot),
  ]);

  const manifest = JSON.parse(await readFile(
    path.join(installedRoot, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(manifest.name, "codex-small-loop");

  const commandDirectory = path.join(installedRoot, "components", "commands");
  const commands = (await readdir(commandDirectory))
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  assert.ok(commands.length > 0);
  for (const command of commands) {
    const checked = runNode(["--check", path.join(commandDirectory, command)], projectRoot);
    assert.equal(checked.status, 0, `${command}: ${checked.stderr}`);
  }

  const role = runNode([
    path.join(commandDirectory, "role.mjs"),
    "controller",
  ], projectRoot);
  assert.equal(role.status, 0, role.stderr);
  assert.match(role.stdout, /# Controller/);

  const status = runNode([
    path.join(commandDirectory, "runtime.mjs"),
    "status",
    "--project-root",
    projectRoot,
  ], projectRoot);
  assert.equal(status.status, 2, status.stderr);
  const result = JSON.parse(status.stdout);
  assert.equal(result.run, "degraded");
  assert.equal(result.readiness, "setup_required");
  assert.equal(result.projectRoot, projectRoot);
});
