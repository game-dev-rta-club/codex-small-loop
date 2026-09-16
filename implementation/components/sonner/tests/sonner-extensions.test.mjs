import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildSonner, serializeSonner } from "../source/sonner.mjs";
import { formatSonnerText } from "../source/sonner-text.mjs";
import { parseSonnerConfig } from "../source/sonner-options.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../commands/small-loop.mjs", import.meta.url));
const settings = { version: 1, extensions: [
  { suffix: ".meta", module: "tools/extract.mjs" },
  { suffix: ".cs", module: "tools/extract.mjs" },
] };
const marker = (id, type = "Overview", input = "") => `<work-node id="${id}" type="${type}"><keyPoints>Work knowledge</keyPoints><inputs>${input ? `<input ref="${input}"/>` : ""}</inputs></work-node>`;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sonner-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet", root]);
  const write = async (name, value) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), value); };
  await write(".sonner.json", JSON.stringify(settings));
  await write("tools/extract.mjs", `export const apiVersion = 1;
    export function extract({path, text}) {
      if (path.endsWith('.meta')) return {keyPoints: text.includes('configuration') ? 'Player prefab configuration' : null};
      return {summary: text.includes('Player movement.') ? 'Player: Player movement.' : null};
    }`);
  await write(".WORK_NODE.xml", marker("root"));
  await write("Combat/.WORK_NODE.xml", marker("combat", "Implementation", "root"));
  await write("Combat/Player.cs.meta", 'fileFormatVersion: 2\nguid: abc\nkeyPoints: >-\n  Player prefab\n  configuration\n');
  await write("Combat/Player.cs", '// header\n'.repeat(80) + '/// <summary>Player movement.</summary>\npublic class Player {}\n');
  await write("Combat/Deep/info.md", '---\nkeyPoints: Deep knowledge\n---\n');
  await write("Other/.WORK_NODE.xml", "broken outside scope");
  return { root, write };
}
test("configuration validates module declarations, duplicate suffixes and escaping paths", () => {
  for (const value of [{ version: 1, module: './run.mjs' }, { version: 1, exclude: ['../secret'] },
    { version: 1, extensions: [settings.extensions[0], settings.extensions[0]] },
    { version: 1, extensions: [{ suffix: '.cs', module: '../outside.mjs' }] }]) {
    assert.throws(() => parseSonnerConfig(Buffer.from(JSON.stringify(value))), { code: 'SONNER_CONFIG_INVALID' });
  }
});
for (const platform of process.platform === "darwin" ? ["darwin", "win32"] : ["win32"]) {
  test(`${platform}: scoped reads apply project extensions and explicitly expose a partial graph`, async (t) => {
    const { root, write } = await fixture(t);
    const read = (query = {}) => buildSonner(root, { includeRuntime: false, query: { extensions: true, ...query }, readerOptions: { platform } });
    const value = await read({ path: 'Combat' });
    assert.equal(value.workGraph.status, 'partial');
    assert.deepEqual(value.workGraph.works.map((work) => work.id), ['combat']);
    assert.deepEqual(value.workGraph.works[0].inputs, ['root']);
    assert.equal(value.files.root.path, 'Combat');
    const text = formatSonnerText(value);
    assert.match(text, /Player.cs summary="Player: Player movement\."/);
    assert.match(text, /Player.cs.meta keyPoints="Player prefab configuration"/);
    assert.match(text, /Combat\/ \[WORK_NODE: combat\]/);
    assert.doesNotMatch(text, /Other|1 meta|1 cs/);
    const hidden = await read({ path: 'Combat', noKeyPoints: true, depth: 0 });
    assert.doesNotMatch(serializeSonner(hidden), /keyPoints|Deep knowledge/);
    assert.match(formatSonnerText(hidden), /deeper directories omitted/);
    assert.match(formatSonnerText(hidden), /Player movement/);
    assert.equal((await read()).workGraph.status, 'invalid');
    await write('.sonner.json', JSON.stringify({ ...settings, include: ['Combat'], exclude: ['Combat/Deep'] }));
    const configured = await read();
    assert.equal(configured.workGraph.status, 'partial');
    assert.doesNotMatch(formatSonnerText(configured), /Deep knowledge/);
    await write('.sonner.json', '{broken');
    await assert.rejects(read(), { code: 'SONNER_CONFIG_INVALID' });
  });
}
test("CLI accepts composable query flags and rejects ambiguous or escaping arguments", async (t) => {
  const { root } = await fixture(t);
  const run = (...args) => exec(process.execPath, [cli, 'sonner', ...args], { cwd: root });
  const result = JSON.parse((await run('--extensions', '--path', 'Combat', '--depth', '0', '--no-key-points', '--json')).stdout);
  assert.equal(result.files.root.path, 'Combat');
  assert.equal(result.files.root.truncated, true);
  for (const args of [['--path', '../outside'], ['--path'], ['--path', '--json'], ['--depth', '-1'], ['--depth', '129'], ['--depth', 'x'], ['--no-key-points', '--no-key-points']]) {
    await assert.rejects(run(...args), (error) => error.code === 1);
  }
});

test("extensions require opt-in and failures are bounded", async (t) => {
  const { root, write } = await fixture(t);
  const read = (enabled, timeoutMs = 5000) => buildSonner(root, { includeRuntime: false,
    query: { path: 'Combat', extensions: enabled }, readerOptions: { timeoutMs } });
  await write('tools/extract.mjs', 'throw new Error("must not run without opt-in");');
  assert.doesNotMatch(formatSonnerText(await read(false)), /summary=/);
  await assert.rejects(read(true), { code: 'SONNER_EXTENSION_FAILED' });
  await write('tools/extract.mjs', 'export const apiVersion=1; export function extract() { return {summary: 123}; }');
  await assert.rejects(read(true), { code: 'SONNER_EXTENSION_FAILED' });
  await write('tools/extract.mjs', 'export const apiVersion=1; export function extract() { while (true) {} }');
  await assert.rejects(read(true, 1000));
});

test("metadata-only keeps annotated files and ancestors, with stable hide/depth composition", async (t) => {
  const { root, write } = await fixture(t);
  await write('Empty/plain.txt', 'No annotation');
  await write('Warnings/WORK_NODE.xml', 'legacy');
  await write('tools/extract.mjs', `export const apiVersion = 1;
    export function extract({path}) {
      return path.endsWith('.cs') ? {keyPoints: 'Code knowledge', summary: 'Code summary'} : {keyPoints: 'Meta knowledge'};
    }`);
  const read = (query = {}) => buildSonner(root, { includeRuntime: false, query: { extensions: true, ...query } });
  const full = await read();
  const filtered = await read({ metadataOnly: true });
  assert.deepEqual(filtered.workGraph, full.workGraph);
  assert.equal(filtered.metadataOnly, true);
  assert.match(formatSonnerText(filtered), /counts include listed files/);
  const paths = [];
  const visit = (node) => {
    assert.ok(['directory', 'file', 'file-counts'].includes(node.type));
    if (node.type === 'file-counts') return;
    if (node.type === 'file') assert.ok(node.keyPoints || node.summary);
    paths.push(node.path);
    for (const child of node.children ?? []) visit(child);
  };
  visit(filtered.files.root);
  assert.deepEqual(paths, ['.', 'Combat', 'Combat/Deep', 'Combat/Deep/info.md', 'Combat/Player.cs', 'Combat/Player.cs.meta']);
  const combatCounts = filtered.files.root.children[0].children.find((child) => child.type === 'file-counts');
  assert.deepEqual(combatCounts.counts, [{ extension: 'cs', count: 1 }, { extension: 'meta', count: 1 }]);
  const deepCounts = filtered.files.root.children[0].children[0].children.find((child) => child.type === 'file-counts');
  assert.deepEqual(deepCounts.counts, [{ extension: 'md', count: 1 }]);
  const hidden = await read({ metadataOnly: true, noKeyPoints: true, depth: 1 });
  assert.doesNotMatch(serializeSonner(hidden), /"keyPoints"/);
  const combat = hidden.files.root.children[0];
  assert.equal(combat.truncated, true);
  assert.deepEqual(combat.children.find((child) => child.type === 'file-counts'), combatCounts);
  assert.deepEqual(combat.children.filter((child) => child.type === 'file').map((child) => child.path), ['Combat/Player.cs', 'Combat/Player.cs.meta']);
  const empty = await read({ metadataOnly: true, path: 'Empty' });
  assert.deepEqual(empty.files.root.children, []);
  const cliValue = JSON.parse((await exec(process.execPath, [cli, 'sonner', '--extensions', '--metadata-only', '--json'], { cwd: root })).stdout);
  assert.deepEqual(cliValue, filtered);
  await assert.rejects(exec(process.execPath, [cli, 'sonner', '--metadata-only', '--metadata-only'], { cwd: root }), (error) => error.code === 1);
  await assert.rejects(read({ metadataOnly: 'yes' }), { code: 'SONNER_CONFIG_INVALID' });
});

for (const platform of process.platform === 'darwin' ? ['darwin', 'win32'] : ['win32']) {
  test(`${platform}: description survives JSON, text, hiding and metadata-only counts`, async (t) => {
    const { root, write } = await fixture(t);
    const description = 'プレイヤーを上に弾き飛ばすジャンプ台。';
    await write('Combat/ジャンプ台.prefab.meta', 'description: ' + description);
    await write('tools/extract.mjs', `export const apiVersion = 1;
      export function extract({path}) {
        if (path.endsWith('ジャンプ台.prefab.meta')) return {description: ${JSON.stringify('  ' + description + '  ')}};
        if (path.endsWith('.cs')) return {keyPoints: 'knowledge', summary: 'summary', description: 'code description'};
        return {description: '  '};
      }`);
    const read = (query = {}) => buildSonner(root, { includeRuntime: false,
      query: { extensions: true, path: 'Combat', ...query }, readerOptions: { platform } });
    const full = await read();
    const asset = full.files.root.children.find((node) => node.name === 'ジャンプ台.prefab.meta');
    assert.equal(JSON.parse(serializeSonner(full)).files.root.children.find((node) => node.path === asset.path).description, description);
    assert.equal(asset.summary, undefined);
    assert.equal(asset.keyPoints, null);
    assert.match(formatSonnerText(full), /ジャンプ台.prefab.meta description="プレイヤーを上に弾き飛ばすジャンプ台。"/);
    assert.deepEqual(full.files.root.children.find((node) => node.type === 'file-counts').counts, [{extension: 'meta', count: 1}, {extension: 'xml', count: 1}]);
    const hidden = await read({ noKeyPoints: true, metadataOnly: true });
    assert.doesNotMatch(serializeSonner(hidden), /"keyPoints"/);
    assert.match(formatSonnerText(hidden), /summary="summary" description="code description"/);
    assert.match(formatSonnerText(hidden), /ジャンプ台.prefab.meta description=/);
    assert.deepEqual(hidden.files.root.children.find((node) => node.type === 'file-counts').counts,
      [{extension: 'cs', count: 1}, {extension: 'meta', count: 1}]);
    assert.ok(!hidden.files.root.children.some((node) => node.name === 'Player.cs.meta'));
  });
}

test('description retains metadata validation and length limits', async (t) => {
  const { root, write } = await fixture(t);
  const read = () => buildSonner(root, { includeRuntime: false, query: { extensions: true, path: 'Combat' } });
  for (const value of ['123', '[]', '{}', '"x".repeat(8193)']) {
    await write('tools/extract.mjs', `export const apiVersion=1; export function extract() { return {description: ${value}}; }`);
    await assert.rejects(read(), {code: 'SONNER_EXTENSION_FAILED'});
  }
  await write('tools/extract.mjs', 'export const apiVersion=1; export function extract() { return {description: "x".repeat(8192)}; }');
  assert.equal((await read()).files.root.children.find((node) => node.type === 'file').description.length, 8192);
  await write('tools/extract.mjs', 'export const apiVersion=1; export function extract() { return {description: null, arbitrary: "no"}; }');
  await assert.rejects(read(), {code: 'SONNER_EXTENSION_FAILED'});
  await write('tools/extract.mjs', 'export const apiVersion=1; export function extract() { return {description: null}; }');
  assert.doesNotMatch(serializeSonner(await read()), /"description"/);
});
