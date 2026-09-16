import { validMetadataKey } from "./sonner-metadata.mjs";
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const worker = fileURLToPath(new URL("./sonner-extension-worker.mjs", import.meta.url));
function failed(detail = "") {
  const error = new Error("Sonner project extension failed or exceeded its limits.");
  error.code = "SONNER_EXTENSION_FAILED";
  if (detail) error.details = detail.slice(0, 4096);
  return error;
}
export async function runSonnerExtensions(project, entries, extensions, session) {
  if (!extensions.length) return new Map();
  const modules = new Map();
  const files = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const rule = extensions.find(({ suffix }) => entry.path.toLowerCase().endsWith(suffix));
    if (!rule) continue;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(entry.raw, { stream: entry.raw.length === 64 * 1024 }); } catch { continue; }
    if (!modules.has(rule.module)) {
      const filename = path.join(project.root, ...rule.module.split("/"));
      const canonical = await realpath(filename);
      const relative = path.relative(project.root, canonical);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          || !(await lstat(filename)).isFile()) throw failed();
      modules.set(rule.module, canonical);
    }
    files.push({ path: entry.path, text, module: modules.get(rule.module) });
  }
  if (!files.length) return new Map();
  session.throwIfAborted();
  const child = spawn(process.execPath, ["--max-old-space-size=128", worker], {
    cwd: project.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {},
  });
  const input = JSON.stringify({ modules: [...new Set(modules.values())], files });
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let stderr = "";
  let failure = false;
  const fail = () => { failure = true; child.kill("SIGKILL"); };
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > 16 * 1024 * 1024) { fail(); return; }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) fail(); else if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
  session.signal.addEventListener("abort", fail, { once: true });
  if (session.signal.aborted || Buffer.byteLength(input) > 64 * 1024 * 1024) fail();
  child.stdin.end(input);
  try {
    const { code, signal } = await closed;
    session.throwIfAborted();
    if (failure || code !== 0 || signal) throw failed(stderr);
    let output;
    try { output = JSON.parse(stdout.toString("utf8")); } catch { throw failed(); }
    if (!Array.isArray(output) || output.length !== files.length) throw failed();
    const result = new Map();
    output.forEach((value, index) => {
      if (!value || value.path !== files[index].path
          || Object.keys(value).some((key) => key !== "path" && !validMetadataKey(key))) throw failed();
      for (const key of Object.keys(value).filter((key) => key !== "path")) {
        if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].length || value[key].length > 8192)) throw failed();
      }
      const { path: filename, ...metadata } = value;
      result.set(filename, metadata);
    });
    return result;
  } finally {
    session.signal.removeEventListener("abort", fail);
  }
}
