import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProject } from "./project.mjs";
import {
  resolveCurrentReviewSnapshot,
} from "./review-snapshot.mjs";
import { normalizeLineEndings } from "./text-line-endings.mjs";

const MAX_ERROR_LENGTH = 512;
const MAX_TASK_ID_LENGTH = 512;
const MAX_SIGNAL_NAME_LENGTH = 128;
const MAX_SIGNAL_COUNT = 1_000;
const MAX_SIGNAL_BYTES = 256 * 1_024;
const MAX_FRONTMATTER_BYTES = 8 * 1_024;
const MAX_SUMMARY_LENGTH = 240;
const SNAPSHOT_PATTERN = /^[0-9a-f]{40,64}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SIGNAL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const TEMPLATE_PLACEHOLDER_PATTERN = /^<[^>\r\n]+>$/u;
const REVIEW_SIGNAL_SEVERITIES = new Set([
  "required",
  "consider",
  "later",
  "dismiss",
]);
const UNSUPPORTED_DIRECTORY_SYNC = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
]);
const templateFiles = new Map([
  [
    "review-signal",
    fileURLToPath(
      new URL("../templates/signals/review-signal.md", import.meta.url),
    ),
  ],
]);

export class SignalError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "SignalError";
    this.code = code;
  }
}

function bounded(value, maximum = MAX_ERROR_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function signalError(code, message, cause) {
  return new SignalError(code, bounded(message), cause);
}

function requirePrimaryTaskId(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TASK_ID_LENGTH
    || !TASK_ID_PATTERN.test(value)
  ) {
    throw signalError(
      "SIGNAL_INVALID",
      "Primary Task ID must be a safe bounded identifier.",
    );
  }
  return value;
}

function requireCurrentSnapshot(value) {
  if (typeof value !== "string" || !SNAPSHOT_PATTERN.test(value)) {
    throw signalError(
      "SIGNAL_INVALID",
      "Current snapshot must be a full hexadecimal Git object ID.",
    );
  }
  return value;
}

function requireSignalName(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SIGNAL_NAME_LENGTH
    || !SIGNAL_NAME_PATTERN.test(value)
  ) {
    throw signalError(
      "SIGNAL_INVALID",
      "Signal name must be a bounded lowercase kebab-case name.",
    );
  }
  return value;
}

function requireTemplateName(value) {
  if (typeof value !== "string" || !templateFiles.has(value)) {
    throw signalError(
      "SIGNAL_TEMPLATE_UNKNOWN",
      "Signal template must name a bundled template.",
    );
  }
  return value;
}

function requireSeverity(value) {
  if (
    typeof value !== "string"
    || !REVIEW_SIGNAL_SEVERITIES.has(value.toLowerCase())
  ) {
    throw signalError(
      "SIGNAL_INVALID",
      "Review Signal severity must be required, consider, later, or dismiss.",
    );
  }
  return value.toLowerCase();
}

function portableRelativePath(projectRoot, file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

function emptySignalMetadata() {
  return {
    template: "unknown",
    severity: "unknown",
    summary: "(none)",
    valid: false,
  };
}

function frontmatterEnd(source) {
  const withTrailingNewline = source.indexOf("\n---\n", 4);
  if (withTrailingNewline >= 0) return withTrailingNewline;
  return source.endsWith("\n---") ? source.length - 4 : -1;
}

function frontmatterScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && trimmed.startsWith("\"")
    && trimmed.endsWith("\"")
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (
    trimmed.length >= 2
    && trimmed.startsWith("'")
    && trimmed.endsWith("'")
  ) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseSignalMetadata(source) {
  const normalized = normalizeLineEndings(source);
  if (!normalized.startsWith("---\n")) {
    return emptySignalMetadata();
  }
  const end = frontmatterEnd(normalized);
  if (end < 0 || end > MAX_FRONTMATTER_BYTES) {
    return emptySignalMetadata();
  }
  const fields = new Map();
  let duplicateField = false;
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = frontmatterScalar(line.slice(separator + 1));
    if (fields.has(key)) duplicateField = true;
    fields.set(key, value);
  }

  const rawSummary = fields.get("summary")?.trim() ?? "";
  const validSummary = rawSummary.length > 0
    && rawSummary.length <= MAX_SUMMARY_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(rawSummary)
    && !TEMPLATE_PLACEHOLDER_PATTERN.test(rawSummary);
  const summary = !validSummary
    ? "(none)"
    : bounded(rawSummary, MAX_SUMMARY_LENGTH);
  const rawTemplate = fields.get("template")?.trim() ?? "";
  const template = templateFiles.has(rawTemplate) ? rawTemplate : "unknown";
  const severity = fields.get("severity")?.trim().toLowerCase() ?? "unknown";
  const requiredFields = ["template", "severity", "summary"];
  const exactFields = fields.size === requiredFields.length
    && requiredFields.every((key) => fields.has(key));
  return {
    template,
    severity,
    summary,
    valid: !duplicateField
      && template !== "unknown"
      && template === "review-signal"
      && REVIEW_SIGNAL_SEVERITIES.has(severity)
      && validSummary
      && exactFields,
  };
}

async function readSignalMetadata(file) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        template: "unknown",
        severity: "unknown",
        summary: "(none)",
        valid: false,
      };
    }
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES + 1);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      0,
    );
    return parseSignalMetadata(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return emptySignalMetadata();
  } finally {
    await handle?.close();
  }
}

async function readSignalSource(file) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SIGNAL_BYTES) {
      throw signalError(
        "SIGNAL_INVALID",
        "Signal must be a bounded regular file.",
      );
    }
    return await handle.readFile("utf8");
  } catch (cause) {
    if (cause instanceof SignalError) throw cause;
    if (cause?.code === "ENOENT") {
      throw signalError("SIGNAL_NOT_FOUND", "Signal does not exist.", cause);
    }
    throw signalError(
      "SIGNAL_READ_FAILED",
      cause?.message ?? "Signal could not be read.",
      cause,
    );
  } finally {
    await handle?.close();
  }
}

function severitySignalSource(source, severity) {
  const normalized = normalizeLineEndings(source);
  if (!normalized.startsWith("---\n")) {
    throw signalError("SIGNAL_INVALID", "Signal frontmatter is missing.");
  }
  const end = frontmatterEnd(normalized);
  if (end < 0) {
    throw signalError("SIGNAL_INVALID", "Signal frontmatter is incomplete.");
  }
  const lines = normalized.slice(4, end).split("\n");
  const values = new Map();
  let duplicateField = false;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (values.has(key)) duplicateField = true;
    values.set(
      key,
      frontmatterScalar(line.slice(separator + 1)),
    );
  }
  if (duplicateField) {
    throw signalError("SIGNAL_INVALID", "Signal frontmatter has duplicate fields.");
  }
  if (!templateFiles.has(values.get("template"))) {
    throw signalError("SIGNAL_INVALID", "Signal template is not recognized.");
  }
  if (values.get("template") !== "review-signal") {
    throw signalError("SIGNAL_INVALID", "Signal template cannot set severity.");
  }
  const summary = values.get("summary")?.trim() ?? "";
  if (
    summary.length === 0
    || summary.length > MAX_SUMMARY_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(summary)
    || TEMPLATE_PLACEHOLDER_PATTERN.test(summary)
  ) {
    throw signalError(
      "SIGNAL_INVALID",
      "Signal summary must be one non-empty bounded line.",
    );
  }
  if (
    !REVIEW_SIGNAL_SEVERITIES.has(
      values.get("severity")?.trim().toLowerCase(),
    )
  ) {
    throw signalError(
      "SIGNAL_INVALID",
      "Review Signal has an invalid current severity.",
    );
  }
  for (const required of ["template", "severity", "summary"]) {
    if (!values.has(required)) {
      throw signalError(
        "SIGNAL_INVALID",
        `Signal frontmatter is missing ${required}.`,
      );
    }
  }
  if (values.size !== 3) {
    throw signalError(
      "SIGNAL_INVALID",
      "Review Signal frontmatter contains unsupported fields.",
    );
  }

  const currentSeverity = values.get("severity").trim().toLowerCase();
  if (currentSeverity === severity) {
    return { source: normalized, changed: false };
  }

  const updated = lines.map((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return line;
    const key = line.slice(0, separator).trim();
    return key === "severity" ? `severity: ${severity}` : line;
  });
  return {
    source: `---\n${updated.join("\n")}${normalized.slice(end)}`,
    changed: true,
  };
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (cause) {
    if (
      !UNSUPPORTED_DIRECTORY_SYNC.has(cause?.code)
      && !(process.platform === "win32" && cause?.code === "EPERM")
    ) throw cause;
  } finally {
    await handle?.close();
  }
}

async function createSignalAtomically(file, source) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function writeSignalAtomically(file, source) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (cause) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw signalError(
      "SIGNAL_WRITE_FAILED",
      cause?.message ?? "Signal severity could not be written.",
      cause,
    );
  }
}

async function signalFiles(directory, { validateNames = true } = {}) {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw signalError(
      "SIGNAL_READ_FAILED",
      error?.message ?? "Review signal directory could not be read.",
      error,
    );
  }

  const files = [];
  try {
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const signalName = entry.name.slice(0, -3);
      if (
        validateNames
        && (
          signalName.length === 0
          || signalName.length > MAX_SIGNAL_NAME_LENGTH
          || !SIGNAL_NAME_PATTERN.test(signalName)
        )
      ) {
        throw signalError(
          "SIGNAL_INVALID",
          "Signal directory contains an unsafe record name.",
        );
      }
      files.push(entry.name);
      if (files.length > MAX_SIGNAL_COUNT) {
        throw signalError(
          "SIGNAL_LIMIT",
          `Signal count exceeds ${MAX_SIGNAL_COUNT}.`,
        );
      }
    }
  } finally {
    await entries.close().catch(() => {});
  }
  return files;
}

async function requireMatchingSnapshot({
  primaryTaskId,
  currentSnapshot,
  projectRoot,
}) {
  let resolved;
  try {
    resolved = await resolveCurrentReviewSnapshot({
      primaryTaskId,
      projectRoot,
    });
  } catch (cause) {
    throw signalError(
      "SIGNAL_SNAPSHOT_UNAVAILABLE",
      cause?.message ?? "The current Review snapshot could not be resolved.",
      cause,
    );
  }
  if (resolved.currentSnapshot !== currentSnapshot) {
    throw signalError(
      "SIGNAL_SNAPSHOT_MISMATCH",
      "The supplied snapshot is not the Primary Task's current Review snapshot.",
    );
  }
  return resolved;
}

export async function createSignal({
  primaryTaskId,
  currentSnapshot,
  signalName,
  templateName,
  projectRoot,
}) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  currentSnapshot = requireCurrentSnapshot(currentSnapshot);
  signalName = requireSignalName(signalName);
  templateName = requireTemplateName(templateName);
  const project = await resolveProject(projectRoot);
  await requireMatchingSnapshot({
    primaryTaskId,
    currentSnapshot,
    projectRoot: project.root,
  });

  const directory = path.join(
    project.directory,
    "signals",
    primaryTaskId,
    currentSnapshot,
  );
  const file = path.join(directory, `${signalName}.md`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const source = normalizeLineEndings(
      await readFile(templateFiles.get(templateName), "utf8"),
    );
    await createSignalAtomically(file, source);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw signalError(
        "SIGNAL_EXISTS",
        `Signal already exists: ${portableRelativePath(project.root, file)}`,
        cause,
      );
    }
    throw signalError(
      "SIGNAL_WRITE_FAILED",
      cause?.message ?? "Signal template could not be copied.",
      cause,
    );
  }

  return {
    run: "ok",
    operation: "signal-create",
    primaryTaskId,
    currentSnapshot,
    signalName,
    templateName,
    directory,
    file,
    relativeFile: portableRelativePath(project.root, file),
  };
}

export async function setSignalSeverity({
  primaryTaskId,
  currentSnapshot,
  signalName,
  severity,
  projectRoot,
}) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  currentSnapshot = requireCurrentSnapshot(currentSnapshot);
  signalName = requireSignalName(signalName);
  severity = requireSeverity(severity);
  const project = await resolveProject(projectRoot);
  await requireMatchingSnapshot({
    primaryTaskId,
    currentSnapshot,
    projectRoot: project.root,
  });

  const file = path.join(
    project.directory,
    "signals",
    primaryTaskId,
    currentSnapshot,
    `${signalName}.md`,
  );
  const updated = severitySignalSource(await readSignalSource(file), severity);
  if (updated.changed) await writeSignalAtomically(file, updated.source);

  return {
    run: "ok",
    operation: "signal-set-severity",
    primaryTaskId,
    currentSnapshot,
    signalName,
    severity,
    file,
    relativeFile: portableRelativePath(project.root, file),
    changed: updated.changed,
  };
}

export async function listSignals({
  primaryTaskId,
  currentSnapshot,
  projectRoot,
}) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  currentSnapshot = requireCurrentSnapshot(currentSnapshot);
  const project = await resolveProject(projectRoot);
  await requireMatchingSnapshot({
    primaryTaskId,
    currentSnapshot,
    projectRoot: project.root,
  });

  const directory = path.join(
    project.directory,
    "signals",
    primaryTaskId,
    currentSnapshot,
  );
  const legacyDirectory = path.join(
    project.directory,
    "issues",
    primaryTaskId,
    currentSnapshot,
  );
  if ((await signalFiles(legacyDirectory, { validateNames: false })).length > 0) {
    throw signalError(
      "SIGNAL_LEGACY_ISSUES_PRESENT",
      "Legacy Review issues exist for this snapshot. Start a fresh Review pass with Signal-capable reviewers.",
    );
  }
  const signals = [];
  const invalidFiles = [];
  for (const file of await signalFiles(directory)) {
    const fullPath = path.join(directory, file);
    const { valid, ...metadata } = await readSignalMetadata(
      fullPath,
    );
    if (!valid) {
      invalidFiles.push(file);
    } else {
      signals.push({ ...metadata, file });
    }
  }
  if (invalidFiles.length > 0) {
    throw signalError(
      "SIGNAL_INVALID_RECORDS",
      `Signal records are malformed: ${invalidFiles.join(", ")}`,
    );
  }
  signals.sort((left, right) => left.file.localeCompare(right.file, "en"));

  return {
    run: "ok",
    operation: "signal-list",
    primaryTaskId,
    currentSnapshot,
    directory: portableRelativePath(project.root, directory),
    signals,
  };
}
