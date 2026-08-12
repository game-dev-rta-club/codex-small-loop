import path from "node:path";

import {
  attestInstalledDesktopCodex,
} from "./codex-desktop-runtime.mjs";
import {
  resolveWindowsExternalCodex,
} from "./codex-windows-runtime.mjs";

const DEFAULT_ADAPTERS = Object.freeze({
  darwin: Object.freeze({
    source: "desktop-bundled",
    resolve: attestInstalledDesktopCodex,
  }),
  win32: Object.freeze({
    source: "external-cli",
    resolve: resolveWindowsExternalCodex,
  }),
});

function resolverError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexRuntimeResolverError";
  error.code = code;
  return error;
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeRuntime(runtime, { platform, source }) {
  const executablePath = runtime?.executablePath;
  const version = runtime?.version;
  if (
    typeof executablePath !== "string"
    || !pathApi(platform).isAbsolute(executablePath)
    || typeof version !== "string"
    || version.length === 0
  ) {
    throw resolverError(
      "CODEX_RUNTIME_INVALID",
      `The ${platform} Codex runtime adapter returned an invalid runtime.`,
    );
  }

  return Object.freeze({
    ...runtime,
    executablePath,
    version,
    source,
    platform,
  });
}

export async function resolveCodexRuntime({
  platform = process.platform,
  adapters = DEFAULT_ADAPTERS,
} = {}) {
  const adapter = adapters?.[platform];
  if (
    adapter === null
    || typeof adapter !== "object"
    || typeof adapter.resolve !== "function"
    || typeof adapter.source !== "string"
    || adapter.source.length === 0
  ) {
    throw resolverError(
      "CODEX_RUNTIME_PLATFORM_UNSUPPORTED",
      `Codex Small Loop has no Codex runtime adapter for ${platform}.`,
    );
  }

  let runtime;
  try {
    runtime = await adapter.resolve();
  } catch (cause) {
    if (typeof cause?.code === "string") throw cause;
    throw resolverError(
      "CODEX_RUNTIME_RESOLUTION_FAILED",
      `The ${platform} Codex runtime could not be resolved.`,
      cause,
    );
  }
  return normalizeRuntime(runtime, { platform, source: adapter.source });
}
