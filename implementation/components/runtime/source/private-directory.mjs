import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const PRIVATE_DIRECTORY_VARIABLE = "CODEX_SMALL_LOOP_PRIVATE_DIRECTORY";
const WINDOWS_ACL_TIMEOUT_MS = 10_000;
const WINDOWS_ACL_MAX_BYTES = 16 * 1_024;
const WINDOWS_FULL_CONTROL = 2_032_127;
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

export class PrivateDirectoryError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "PrivateDirectoryError";
    this.code = code;
  }
}

function privateDirectoryError(code, message, cause) {
  return new PrivateDirectoryError(code, message, cause);
}

function requireDirectory(directory, platform) {
  const implementation = platform === "win32" ? path.win32 : path.posix;
  if (typeof directory !== "string" || !implementation.isAbsolute(directory)) {
    throw new TypeError("private directory must be an absolute path");
  }
  return implementation.normalize(directory);
}

function validateWindowsAcl(result) {
  const rules = Array.isArray(result?.rules)
    ? result.rules
    : result?.rules ? [result.rules] : [];
  const expectedSids = new Set([
    result?.current,
    SYSTEM_SID,
    ADMINISTRATORS_SID,
  ]);
  return result?.protected === true
    && typeof result?.current === "string"
    && result.owner === result.current
    && rules.length === expectedSids.size
    && rules.every((rule) => (
      expectedSids.delete(rule?.sid)
      && rule?.rights === WINDOWS_FULL_CONTROL
      && rule?.type === 0
    ))
    && expectedSids.size === 0;
}

async function protectWindowsDirectory(directory, { env, execute }) {
  const systemRoot = env?.SystemRoot ?? env?.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw privateDirectoryError(
      "PRIVATE_DIRECTORY_ACL_UNAVAILABLE",
      "Windows SystemRoot is unavailable for private directory protection.",
    );
  }
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$acl = New-Object Security.AccessControl.DirectorySecurity",
    "$acl.SetOwner($identity.User)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
    "$propagation = [Security.AccessControl.PropagationFlags]::None",
    `foreach ($sidText in @($identity.User.Value, '${SYSTEM_SID}', '${ADMINISTRATORS_SID}')) { $sid = New-Object Security.Principal.SecurityIdentifier($sidText); $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, [Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule) }`,
    `Set-Acl -LiteralPath $env:${PRIVATE_DIRECTORY_VARIABLE} -AclObject $acl`,
    `$_verified = Get-Acl -LiteralPath $env:${PRIVATE_DIRECTORY_VARIABLE}`,
    "$_rules = @($_verified.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = [int]$_.AccessControlType } })",
    "[pscustomobject]@{ protected = $_verified.AreAccessRulesProtected; owner = $_verified.GetOwner([Security.Principal.SecurityIdentifier]).Value; current = $identity.User.Value; rules = $_rules } | ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");

  let output;
  try {
    output = await execute(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], {
      encoding: "utf8",
      env: { ...env, [PRIVATE_DIRECTORY_VARIABLE]: directory },
      maxBuffer: WINDOWS_ACL_MAX_BYTES,
      timeout: WINDOWS_ACL_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (cause) {
    throw privateDirectoryError(
      "PRIVATE_DIRECTORY_ACL_UNAVAILABLE",
      "The Windows private directory ACL could not be applied.",
      cause,
    );
  }

  let result;
  try {
    result = JSON.parse(output.stdout);
  } catch (cause) {
    throw privateDirectoryError(
      "PRIVATE_DIRECTORY_ACL_INVALID",
      "The Windows private directory ACL result was invalid.",
      cause,
    );
  }
  if (!validateWindowsAcl(result)) {
    throw privateDirectoryError(
      "PRIVATE_DIRECTORY_ACL_INVALID",
      "The Windows private directory ACL did not match the required policy.",
    );
  }
}

export async function protectPrivateDirectory(directory, {
  platform = process.platform,
  env = process.env,
  execute = executeFile,
  chmodDirectory = chmod,
} = {}) {
  directory = requireDirectory(directory, platform);
  if (platform === "win32") {
    await protectWindowsDirectory(directory, { env, execute });
    return Object.freeze({ directory, strategy: "windows-acl" });
  }
  await chmodDirectory(directory, 0o700);
  return Object.freeze({ directory, strategy: "posix-mode" });
}
