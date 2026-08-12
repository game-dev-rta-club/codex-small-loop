import { execFile } from "node:child_process";
import { realpath as realpathFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const macPath = path.posix;

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1_024;
const COMMAND_TIMEOUT_MS = 10_000;
const EXPECTED_IDENTIFIER = "com.openai.codex";
const EXPECTED_TEAM_IDENTIFIER = "2DC432GLL2";

function desktopRuntimeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexDesktopRuntimeError";
  error.code = code;
  return error;
}

function requirePid(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_ANCESTRY_INVALID",
      `${label} must be a positive process ID.`,
    );
  }
  return value;
}

function parseProcess(source, pid) {
  const match = String(source).match(/^\s*(\d+)\s+(.+?)\s*$/s);
  if (!match) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_ANCESTRY_INVALID",
      `Could not read process ancestry for PID ${pid}.`,
    );
  }
  return {
    ppid: requirePid(Number(match[1]), "Parent process ID"),
    executablePath: match[2],
  };
}

export async function readMacProcess(pid) {
  try {
    const output = await execFileAsync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "comm="],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
      },
    );
    return parseProcess(output.stdout, pid);
  } catch (cause) {
    if (cause?.code === "CODEX_DESKTOP_ANCESTRY_INVALID") {
      throw cause;
    }
    throw desktopRuntimeError(
      "CODEX_DESKTOP_ANCESTRY_INVALID",
      `Could not read process ancestry for PID ${pid}.`,
      cause,
    );
  }
}

function deriveAppBundle(executablePath) {
  if (macPath.basename(executablePath) !== "codex") return null;
  const resources = macPath.dirname(executablePath);
  if (macPath.basename(resources) !== "Resources") return null;
  const contents = macPath.dirname(resources);
  if (macPath.basename(contents) !== "Contents") return null;
  const appBundlePath = macPath.dirname(contents);
  return appBundlePath.endsWith(".app") ? appBundlePath : null;
}

function parseApplicationPath(source) {
  const appBundlePath = String(source).trim().replace(/\/+$/, "");
  if (!macPath.isAbsolute(appBundlePath) || !appBundlePath.endsWith(".app")) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_APP_NOT_FOUND",
      "Codex App could not be located through macOS LaunchServices.",
    );
  }
  return appBundlePath;
}

export async function locateMacApplication(bundleId = EXPECTED_IDENTIFIER) {
  try {
    const output = await execFileAsync(
      "/usr/bin/osascript",
      [
        "-e",
        `POSIX path of (path to application id ${JSON.stringify(bundleId)})`,
      ],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
      },
    );
    return parseApplicationPath(output.stdout);
  } catch (cause) {
    if (cause?.code === "CODEX_DESKTOP_APP_NOT_FOUND") {
      throw cause;
    }
    throw desktopRuntimeError(
      "CODEX_DESKTOP_APP_NOT_FOUND",
      "Codex App could not be located through macOS LaunchServices.",
      cause,
    );
  }
}

function readSigningField(source, name) {
  return String(source)
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim() ?? "";
}

async function inspectMacSignature(appBundlePath) {
  try {
    await execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--strict", appBundlePath],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
      },
    );
    const output = await execFileAsync(
      "/usr/bin/codesign",
      ["-dv", "--verbose=2", appBundlePath],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
      },
    );
    return {
      identifier: readSigningField(output.stderr, "Identifier"),
      teamIdentifier: readSigningField(output.stderr, "TeamIdentifier"),
    };
  } catch (cause) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_IDENTITY_INVALID",
      "The Codex Desktop application signature could not be verified.",
      cause,
    );
  }
}

async function readCodexVersion(executablePath) {
  try {
    const output = await execFileAsync(executablePath, ["--version"], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return output.stdout;
  } catch (cause) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_VERSION_INVALID",
      "The Codex Desktop executable version could not be read.",
      cause,
    );
  }
}

function parseVersion(source) {
  return String(source).match(
    /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/,
  )?.[1] ?? null;
}

export async function attestInstalledDesktopCodex({
  platform = process.platform,
  locateApplication = locateMacApplication,
  realpath = realpathFile,
  inspectSignature = inspectMacSignature,
  readVersion = readCodexVersion,
} = {}) {
  if (platform !== "darwin") {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_PLATFORM_UNSUPPORTED",
      "Codex Small Loop currently requires Codex Desktop on macOS.",
    );
  }

  let appBundlePath;
  try {
    appBundlePath = parseApplicationPath(
      await locateApplication(EXPECTED_IDENTIFIER),
    );
  } catch (cause) {
    if (cause?.code === "CODEX_DESKTOP_APP_NOT_FOUND") {
      throw cause;
    }
    throw desktopRuntimeError(
      "CODEX_DESKTOP_APP_NOT_FOUND",
      "Codex App could not be located through macOS LaunchServices.",
      cause,
    );
  }

  let canonicalBundle;
  try {
    canonicalBundle = await realpath(appBundlePath);
  } catch (cause) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_APP_NOT_FOUND",
      "The Codex App bundle located by macOS could not be resolved.",
      cause,
    );
  }

  const identity = await inspectSignature(canonicalBundle);
  if (
    identity?.identifier !== EXPECTED_IDENTIFIER
    || identity?.teamIdentifier !== EXPECTED_TEAM_IDENTIFIER
  ) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_IDENTITY_INVALID",
      "The Codex Desktop application has an unexpected signing identity.",
    );
  }

  const expectedExecutable = macPath.join(
    canonicalBundle,
    "Contents",
    "Resources",
    "codex",
  );
  let canonicalExecutable;
  try {
    canonicalExecutable = await realpath(expectedExecutable);
  } catch (cause) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_IDENTITY_INVALID",
      "The signed Codex App does not contain a readable Codex executable.",
      cause,
    );
  }
  if (deriveAppBundle(canonicalExecutable) !== canonicalBundle) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_IDENTITY_INVALID",
      "The Codex Desktop executable resolves outside its signed app bundle.",
    );
  }

  const version = parseVersion(await readVersion(canonicalExecutable));
  if (!version) {
    throw desktopRuntimeError(
      "CODEX_DESKTOP_VERSION_INVALID",
      "The Codex Desktop executable returned an invalid version.",
    );
  }
  return Object.freeze({
    executablePath: canonicalExecutable,
    appBundlePath: canonicalBundle,
    version,
  });
}
