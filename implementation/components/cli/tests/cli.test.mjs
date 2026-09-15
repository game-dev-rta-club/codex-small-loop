import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureCli, findNpmCli, PACKAGE } from "../bootstrap.mjs";
import { buildSonner } from "../../sonner/source/sonner.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const bin = "implementation/components/commands/small-loop.mjs";
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "small-loop-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fakeInstall(directory, version = "1.0.0", source = "") {
  const packageRoot = path.join(directory, "node_modules", PACKAGE);
  await mkdir(path.join(packageRoot, path.dirname(bin)), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: PACKAGE, version, bin: { "small-loop": bin },
  }));
  await writeFile(path.join(packageRoot, bin), source);
}

test("bootstrap caches, refreshes, and keeps a working CLI through offline and broken updates", async (t) => {
  const cacheRoot = await temporary(t);
  let installs = 0;
  const now = 1_000_000;
  const install = async (directory) => { installs++; await fakeInstall(directory); };
  const first = await ensureCli({ cacheRoot, now, install });
  assert.equal(await ensureCli({ cacheRoot, now: now + 1, install }), first);
  assert.equal(installs, 1);
  const refreshed = await ensureCli({ cacheRoot, now: now + 86_400_001, install });
  assert.notEqual(refreshed, first);
  assert.equal(installs, 2);
  const warnings = [];
  const offline = { cacheRoot, now: now + 2 * 86_400_001, install: async () => { throw new Error("offline"); }, warn: (s) => warnings.push(s) };
  assert.equal(await ensureCli(offline), refreshed);
  assert.equal(warnings.length, 1);
  assert.equal(await ensureCli({ ...offline, now: offline.now + 1, install }), refreshed);
  assert.equal(installs, 2);
  const broken = { cacheRoot, now: offline.now + 86_400_001, install: (d) => fakeInstall(d, "1.1.0", 'throw new Error("broken release");'), warn: () => {} };
  assert.equal(await ensureCli(broken), refreshed);
  assert.equal(await ensureCli({ ...broken, now: broken.now + 86_400_001, install: (d) => fakeInstall(d, "2.0.0") }), refreshed);
});

test("bootstrap first-run failure is actionable and concurrent installs publish complete packages", async (t) => {
  const cacheRoot = await temporary(t);
  await assert.rejects(ensureCli({ cacheRoot, install: async () => { throw new Error("offline"); } }), /Could not download/);
  const results = await Promise.all(Array.from({ length: 3 }, () => ensureCli({ cacheRoot, install: fakeInstall })));
  for (const entry of results) assert.equal(await readFile(entry, "utf8"), "");
  const selected = await ensureCli({ cacheRoot, install: () => { throw new Error("must use cache"); } });
  assert.ok(results.includes(selected));
});

test("npm tarball runs outside the checkout without Codex and reads hidden Work markers", async (t) => {
  const temporaryRoot = await temporary(t);
  const npmCli = await findNpmCli();
  const { stdout } = await exec(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot], { cwd: root });
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.some((f) => f.path.endsWith("native/sonner-project-reader")));
  assert.ok(!packed.files.some((f) => /\/tests\/|\/board\/|\/roles\/|plugin\.json/.test(f.path)));
  await exec("tar", ["-xzf", packed.filename], { cwd: temporaryRoot });
  const entry = path.join(temporaryRoot, "package", bin);
  const project = path.join(temporaryRoot, "Project With Spaces");
  await mkdir(path.join(project, "overview"), { recursive: true });
  await exec("git", ["init", "--quiet", project]);
  await writeFile(path.join(project, "overview", ".WORK_NODE.xml"), '<work-node id="overview" type="Overview"><keyPoints>Project purpose</keyPoints><inputs/></work-node>');
  await writeFile(path.join(project, "overview", "guide.md"), '---\nkeyPoints: Shared project knowledge\n---\n');
  const env = { ...process.env, CODEX_HOME: path.join(temporaryRoot, "no-codex") };
  const run = (args) => exec(process.execPath, [entry, ...args], { cwd: project, env });
  const value = JSON.parse((await run(["sonner", "--json", "--timeout-ms", "30000"])).stdout);
  assert.equal(value.workGraph.status, "valid");
  assert.equal(value.workGraph.works[0].nodePath, "overview/.WORK_NODE.xml");
  assert.equal(Object.hasOwn(value, "runtime"), false);
  assert.match((await run(["sonner"])).stdout, /Shared project knowledge/);
  assert.doesNotMatch((await run(["sonner"])).stdout, /Runtime:/);
  const full = JSON.parse((await run(["sonner", "--json", "--runtime"])).stdout);
  assert.equal(full.runtime.status, "missing");
  const direct = await buildSonner(project, { includeRuntime: false, runtimeBuilder: () => { throw new Error("must not read runtime"); } });
  assert.deepEqual(value, direct);
  const portable = await buildSonner(project, { includeRuntime: false, readerOptions: { platform: "win32" } });
  assert.deepEqual(value, portable);
  for (const args of [["unknown"], ["sonner", "--wat"], ["sonner", "--timeout-ms", "0"], ["sonner", "--timeout-ms", "300001"], ["sonner", "--runtime", "--runtime"]]) {
    await assert.rejects(run(args), (error) => error.code === 1);
  }
});
