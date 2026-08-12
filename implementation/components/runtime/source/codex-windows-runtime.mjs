import { execFile } from "node:child_process";
import {
  realpath as realpathFile,
  stat as statFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1_024;
const COMMAND_TIMEOUT_MS = 10_000;
const EXPECTED_PUBLISHER = "OpenAI OpCo, LLC";
const EXPLICIT_PATH_VARIABLE = "CODEX_SMALL_LOOP_CODEX_PATH";
const SIGNATURE_TARGET_VARIABLE = "CODEX_SMALL_LOOP_SIGNATURE_TARGET";
const PROCESS_ID_VARIABLE = "CODEX_SMALL_LOOP_PROCESS_ID";

function runtimeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexWindowsRuntimeError";
  error.code = code;
  return error;
}

function explicitCandidate(env) {
  const value = env?.[EXPLICIT_PATH_VARIABLE];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) {
    throw runtimeError(
      "CODEX_EXTERNAL_PATH_INVALID",
      `${EXPLICIT_PATH_VARIABLE} must be an absolute Windows path.`,
    );
  }
  return value;
}

function installedCandidate(env) {
  const localAppData = env?.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !path.win32.isAbsolute(localAppData)) {
    return null;
  }
  return path.win32.join(
    localAppData,
    "Programs",
    "OpenAI",
    "Codex",
    "bin",
    "codex.exe",
  );
}

function windowsAppsPath(candidate) {
  return path.win32.normalize(candidate).toLowerCase().includes(
    `${path.win32.sep}windowsapps${path.win32.sep}`,
  );
}

function powershellExecutable(env) {
  const systemRoot = env?.SystemRoot ?? env?.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw runtimeError(
      "CODEX_EXTERNAL_SIGNATURE_UNAVAILABLE",
      "Windows SystemRoot is unavailable for Codex signature verification.",
    );
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export async function inspectWindowsAuthenticode(
  executablePath,
  { env = process.env, execute = execFileAsync } = {},
) {
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath $env:${SIGNATURE_TARGET_VARIABLE}`,
    "$publisher = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }",
    "[pscustomobject]@{ status = [string]$signature.Status; publisher = $publisher } | ConvertTo-Json -Compress",
  ].join("; ");
  let output;
  try {
    output = await execute(
      powershellExecutable(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          ...env,
          [SIGNATURE_TARGET_VARIABLE]: executablePath,
        },
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (cause) {
    throw runtimeError(
      "CODEX_EXTERNAL_SIGNATURE_UNAVAILABLE",
      "The external Codex Authenticode signature could not be inspected.",
      cause,
    );
  }
  try {
    return JSON.parse(output.stdout);
  } catch (cause) {
    throw runtimeError(
      "CODEX_EXTERNAL_SIGNATURE_UNAVAILABLE",
      "The external Codex Authenticode result was invalid.",
      cause,
    );
  }
}

export async function readWindowsProcess(
  pid,
  { env = process.env, execute = execFileAsync } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("pid must be a positive safe integer");
  }
  const script = [
    `$candidate = Get-Process -Id ([int]$env:${PROCESS_ID_VARIABLE}) -ErrorAction Stop`,
    "[pscustomobject]@{ executablePath = $candidate.Path } | ConvertTo-Json -Compress",
  ].join("; ");
  let output;
  try {
    output = await execute(
      powershellExecutable(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          ...env,
          [PROCESS_ID_VARIABLE]: String(pid),
        },
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (cause) {
    throw runtimeError(
      "CODEX_EXTERNAL_PROCESS_UNAVAILABLE",
      "The external Codex process could not be inspected.",
      cause,
    );
  }
  let processInfo;
  try {
    processInfo = JSON.parse(output.stdout);
  } catch (cause) {
    throw runtimeError(
      "CODEX_EXTERNAL_PROCESS_UNAVAILABLE",
      "The external Codex process result was invalid.",
      cause,
    );
  }
  if (
    typeof processInfo?.executablePath !== "string"
    || !path.win32.isAbsolute(processInfo.executablePath)
  ) {
    throw runtimeError(
      "CODEX_EXTERNAL_PROCESS_UNAVAILABLE",
      "The external Codex process returned no absolute executable path.",
    );
  }
  return Object.freeze({
    executablePath: path.win32.normalize(processInfo.executablePath),
  });
}

async function readVersion(executablePath, execute) {
  let output;
  try {
    output = await execute(executablePath, ["--version"], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (cause) {
    throw runtimeError(
      "CODEX_EXTERNAL_EXECUTION_FAILED",
      "The external Codex executable could not be started.",
      cause,
    );
  }
  const version = String(output.stdout).match(
    /\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i,
  )?.[1];
  if (!version) {
    throw runtimeError(
      "CODEX_EXTERNAL_VERSION_INVALID",
      "The external Codex executable returned an invalid version.",
    );
  }
  return version;
}

export async function resolveWindowsExternalCodex({
  platform = process.platform,
  env = process.env,
  realpath = realpathFile,
  stat = statFile,
  inspectSignature = (executablePath) => inspectWindowsAuthenticode(
    executablePath,
    { env },
  ),
  execute = execFileAsync,
} = {}) {
  if (platform !== "win32") {
    throw runtimeError(
      "CODEX_EXTERNAL_PLATFORM_UNSUPPORTED",
      "The external Windows Codex adapter requires win32.",
    );
  }

  const candidate = explicitCandidate(env) ?? installedCandidate(env);
  if (!candidate) {
    throw runtimeError(
      "CODEX_EXTERNAL_NOT_FOUND",
      `External Codex was not found. Set ${EXPLICIT_PATH_VARIABLE} to its absolute path.`,
    );
  }
  if (windowsAppsPath(candidate)) {
    throw runtimeError(
      "CODEX_EXTERNAL_WINDOWS_APPS_UNSUPPORTED",
      "The packaged WindowsApps Codex executable cannot be used as an external runtime.",
    );
  }

  let executablePath;
  let metadata;
  try {
    executablePath = await realpath(candidate);
    metadata = await stat(executablePath);
  } catch (cause) {
    throw runtimeError(
      "CODEX_EXTERNAL_NOT_FOUND",
      "The external Codex executable could not be resolved.",
      cause,
    );
  }
  if (
    !path.win32.isAbsolute(executablePath)
    || path.win32.basename(executablePath).toLowerCase() !== "codex.exe"
    || typeof metadata?.isFile !== "function"
    || !metadata.isFile()
    || windowsAppsPath(executablePath)
  ) {
    throw runtimeError(
      "CODEX_EXTERNAL_PATH_INVALID",
      "The external Codex path does not resolve to a standalone codex.exe file.",
    );
  }

  const signature = await inspectSignature(executablePath);
  if (
    signature?.status !== "Valid"
    || signature?.publisher !== EXPECTED_PUBLISHER
  ) {
    throw runtimeError(
      "CODEX_EXTERNAL_IDENTITY_INVALID",
      "The external Codex executable has an unexpected Authenticode identity.",
    );
  }

  return Object.freeze({
    executablePath,
    version: await readVersion(executablePath, execute),
    publisher: signature.publisher,
  });
}
