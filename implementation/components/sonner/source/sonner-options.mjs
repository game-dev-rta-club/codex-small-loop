import path from "node:path";

export const SONNER_CONFIG_PATH = ".sonner.json";
export const SONNER_METADATA_BYTES = 64 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = "SONNER_CONFIG_INVALID";
  throw error;
}

export function normalizeSonnerPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
      || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) invalid("Expected a project-relative path.");
  const normalized = value.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  if (normalized !== "." && normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    invalid("Project paths must not escape the project.");
  }
  return normalized;
}

export function below(filename, directory) {
  return directory === "." || filename === directory || filename.startsWith(`${directory}/`);
}

export function parseSonnerConfig(raw) {
  if (raw === null) return { include: ["."], exclude: [], extensions: [] };
  if (raw.length >= SONNER_METADATA_BYTES) invalid("Sonner configuration must be smaller than 64 KiB.");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { invalid("Sonner configuration must be UTF-8 JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || Object.keys(value).some((key) => !["version", "include", "exclude", "extensions"].includes(key))) invalid("Invalid Sonner configuration.");
  const paths = (key, fallback) => {
    const list = value[key] ?? fallback;
    if (!Array.isArray(list) || list.length > 128) invalid(`Invalid ${key} paths.`);
    return list.map(normalizeSonnerPath);
  };
  const extensions = value.extensions ?? [];
  if (!Array.isArray(extensions) || extensions.length > 32) invalid("Invalid Sonner extensions.");
  const seen = new Set();
  for (const extension of extensions) {
    if (!extension || typeof extension !== "object" || Array.isArray(extension)
        || Object.keys(extension).some((key) => !["suffix", "module"].includes(key))
        || !/^\.[a-z0-9][a-z0-9._-]{0,31}$/.test(extension.suffix ?? "")
        || typeof extension.module !== "string" || !extension.module.endsWith(".mjs")
        || seen.has(extension.suffix)) invalid("Invalid or duplicate Sonner extension.");
    if (normalizeSonnerPath(extension.module) === ".") invalid("Invalid extension module path.");
    seen.add(extension.suffix);
  }
  return { include: paths("include", ["."]), exclude: paths("exclude", []),
    extensions: [...extensions].sort((a, b) => b.suffix.length - a.suffix.length) };
}

export function selectSonnerPaths(paths, config, options = {}) {
  const scope = normalizeSonnerPath(options.path ?? ".");
  if (scope !== "." && paths.includes(scope)) invalid("Sonner --path must name a directory.");
  return paths.filter((filename) => below(filename, scope)
    && config.include.some((directory) => below(filename, directory))
    && !config.exclude.some((directory) => below(filename, directory)));
}

export function sonnerReadBytes(filename, extensions, enabled = false) {
  return /\.md$/i.test(filename) || enabled && extensions.some(({ suffix }) => filename.toLowerCase().endsWith(suffix))
    ? SONNER_METADATA_BYTES : 512;
}

export function sonnerSelection(config, options = {}) {
  const scope = normalizeSonnerPath(options.path ?? ".");
  const partial = scope !== "." || config.exclude.length > 0 || !config.include.includes(".");
  return { path: scope, partial, include: config.include, exclude: config.exclude };
}

export function validateSonnerQuery(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)
      || Object.keys(query).some((key) => !["path", "depth", "noKeyPoints", "extensions", "metadataOnly"].includes(key))) invalid("Invalid Sonner query.");
  for (const key of ["noKeyPoints", "extensions", "metadataOnly"]) {
    if (query[key] !== undefined && typeof query[key] !== "boolean") invalid(`Invalid ${key} option.`);
  }
  if (query.depth !== undefined && (!Number.isInteger(query.depth) || query.depth < 0 || query.depth > 128)) invalid("Invalid Sonner depth.");
  return { ...query, ...(query.path === undefined ? {} : { path: normalizeSonnerPath(query.path) }) };
}
