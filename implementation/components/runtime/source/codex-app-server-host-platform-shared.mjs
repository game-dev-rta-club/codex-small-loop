export function platformError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexAppServerHostPlatformError";
  error.code = code;
  return error;
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function requireChild(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    throw platformError(
      "APP_SERVER_HOST_START_FAILED",
      "The Codex app-server returned no process ID.",
    );
  }
  return child;
}

export async function waitUntilReady({
  child,
  endpoint,
  probe,
  timeoutMs,
  retryIntervalMs,
  startupFailure = () => null,
  beforeProbe = async () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const failure = startupFailure();
    if (failure) throw failure;
    if (childExited(child)) {
      throw platformError(
        "APP_SERVER_HOST_EXITED",
        "The Codex app-server exited before becoming ready.",
      );
    }
    await beforeProbe();
    const remaining = Math.max(1, deadline - Date.now());
    if (await probe(endpoint, { timeoutMs: remaining })) return endpoint;
    await sleep(retryIntervalMs);
  }
  throw platformError(
    "APP_SERVER_HOST_NOT_READY",
    "The Codex Small Loop app-server host did not become ready in time.",
  );
}

export function spawnHost(spawnProcess, executablePath, args, options) {
  try {
    return requireChild(spawnProcess(executablePath, args, options));
  } catch (cause) {
    if (cause?.code === "APP_SERVER_HOST_START_FAILED") throw cause;
    throw platformError(
      "APP_SERVER_HOST_START_FAILED",
      "Could not start the Codex app-server.",
      cause,
    );
  }
}

export function childFailureTracker(child) {
  let failure = null;
  child.once("error", (cause) => {
    failure = platformError(
      "APP_SERVER_HOST_START_FAILED",
      "The Codex app-server process failed to start.",
      cause,
    );
  });
  return () => failure;
}
