import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { protectPrivateDirectory } from "./private-directory.mjs";

const UNSUPPORTED_DIRECTORY_SYNC = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
]);

function unsupportedDirectorySync(error, platform) {
  return UNSUPPORTED_DIRECTORY_SYNC.has(error?.code)
    || (platform === "win32" && error?.code === "EPERM");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AtomicJsonStoreError extends Error {
  constructor(code, message, {
    stateFile,
    operation,
    cause,
  }) {
    super(message, cause ? { cause } : undefined);
    this.name = "AtomicJsonStoreError";
    this.code = code;
    this.stateFile = stateFile;
    this.operation = operation;
  }
}

function isOwnerRecord(value) {
  return (
    value
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.token === "string"
    && value.token.length > 0
    && typeof value.createdAt === "string"
    && !Number.isNaN(Date.parse(value.createdAt))
  );
}

function parseOwnerRecord(source) {
  try {
    const owner = JSON.parse(source);
    return isOwnerRecord(owner) ? owner : null;
  } catch {
    return null;
  }
}

export function parseAtomicJsonSource(source, {
  stateFile = "state.json",
  operation = "read",
} = {}) {
  try {
    return JSON.parse(Buffer.isBuffer(source) ? source.toString("utf8") : source);
  } catch (cause) {
    throw new AtomicJsonStoreError(
      "LEDGER_MALFORMED",
      "The JSON state file is malformed.",
      { stateFile, operation, cause },
    );
  }
}

export class AtomicJsonStore {
  constructor(stateFile, {
    lockTimeoutMs = 5_000,
    lockRetryMs = 10,
    now = () => Date.now(),
    id = () => randomUUID(),
    processId = process.pid,
    processProbe = (pid) => process.kill(pid, 0),
    syncHandle = (handle) => handle.sync(),
    platform = process.platform,
    protectDirectory = protectPrivateDirectory,
  } = {}) {
    this.stateFile = stateFile;
    this.lockFile = `${stateFile}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.now = now;
    this.id = id;
    this.processId = processId;
    this.processProbe = processProbe;
    this.syncHandle = syncHandle;
    this.platform = platform;
    this.protectDirectory = protectDirectory;
    this.directoryProtected = false;
  }

  #error(code, operation, message, cause) {
    return new AtomicJsonStoreError(code, message, {
      stateFile: this.stateFile,
      operation,
      cause,
    });
  }

  async #read(operation) {
    let source;

    try {
      source = await readFile(this.stateFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw this.#error(
          "LEDGER_NOT_FOUND",
          operation,
          "The JSON state file does not exist.",
          error,
        );
      }

      throw error;
    }

    return parseAtomicJsonSource(source, { stateFile: this.stateFile, operation });
  }

  async read() {
    return this.#read("read");
  }

  #probeOwner(pid) {
    try {
      this.processProbe(pid);
      return "alive";
    } catch (error) {
      if (error.code === "ESRCH") {
        return "dead";
      }

      if (error.code === "EPERM") {
        return "uncertain";
      }

      throw error;
    }
  }

  async inspectLock() {
    let source;

    try {
      source = await readFile(this.lockFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          status: "absent",
          lockFile: this.lockFile,
        };
      }

      return {
        status: "uncertain",
        lockFile: this.lockFile,
        reason: error.code ?? "LOCK_READ_FAILED",
      };
    }

    const owner = parseOwnerRecord(source);

    if (!owner) {
      return {
        status: "invalid",
        lockFile: this.lockFile,
        reason: "OWNER_RECORD_INVALID",
      };
    }

    let liveness;

    try {
      liveness = this.#probeOwner(owner.pid);
    } catch (error) {
      return {
        status: "uncertain",
        lockFile: this.lockFile,
        owner,
        reason: error.code ?? "OWNER_PROBE_FAILED",
      };
    }

    if (liveness === "dead") {
      return {
        status: "stale",
        lockFile: this.lockFile,
        owner,
      };
    }

    return {
      status: "owned",
      lockFile: this.lockFile,
      owner,
      liveness,
    };
  }

  async #recoverStaleLock() {
    let source;

    try {
      source = await readFile(this.lockFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return "retry";
      }

      return "uncertain";
    }

    const owner = parseOwnerRecord(source);

    if (!owner) {
      return "invalid";
    }

    let liveness;

    try {
      liveness = this.#probeOwner(owner.pid);
    } catch {
      return "uncertain";
    }

    if (liveness !== "dead") {
      return "owned";
    }

    try {
      const revalidated = await readFile(this.lockFile, "utf8");

      if (revalidated !== source) {
        return "retry";
      }

      await rm(this.lockFile);
      return "recovered";
    } catch (error) {
      if (error.code === "ENOENT") {
        return "retry";
      }

      return "uncertain";
    }
  }

  async #acquireLock(operation) {
    const directory = path.dirname(this.stateFile);
    try {
      await mkdir(directory, {
        recursive: true,
        mode: 0o700,
      });
      if (!this.directoryProtected) {
        await this.protectDirectory(directory, { platform: this.platform });
        this.directoryProtected = true;
      }
    } catch (error) {
      throw this.#error(
        "LEDGER_WRITE_FAILED",
        operation,
        "The JSON state directory could not be protected.",
        error,
      );
    }

    const token = this.id();
    const candidate = [
      this.lockFile,
      this.processId,
      token,
      "candidate",
    ].join(".");
    const owner = `${JSON.stringify({
      pid: this.processId,
      token,
      createdAt: new Date(this.now()).toISOString(),
    })}\n`;

    try {
      const candidateHandle = await open(candidate, "wx", 0o600);

      try {
        await candidateHandle.writeFile(owner, "utf8");
        await this.syncHandle(candidateHandle, "file");
      } finally {
        await candidateHandle.close();
      }

      const deadline = this.now() + this.lockTimeoutMs;

      while (true) {
        try {
          await link(candidate, this.lockFile);
          return token;
        } catch (error) {
          if (error.code !== "EEXIST") {
            throw error;
          }

          const recovery = await this.#recoverStaleLock();

          if (recovery === "recovered" || recovery === "retry") {
            continue;
          }

          if (recovery === "invalid") {
            throw this.#error(
              "LEDGER_LOCK_INVALID",
              operation,
              "The lock owner record is invalid and was retained.",
              error,
            );
          }

          if (this.now() >= deadline) {
            throw this.#error(
              "LEDGER_LOCKED",
              operation,
              "The JSON state file is locked by a live or uncertain owner.",
              error,
            );
          }

          await sleep(this.lockRetryMs);
        }
      }
    } catch (error) {
      if (error instanceof AtomicJsonStoreError) {
        throw error;
      }

      throw this.#error(
        "LEDGER_WRITE_FAILED",
        operation,
        "The lock candidate could not be prepared.",
        error,
      );
    } finally {
      await rm(candidate, { force: true });
    }
  }

  async #releaseLock(token) {
    let source;

    try {
      source = await readFile(this.lockFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    const owner = parseOwnerRecord(source);

    if (owner?.token !== token) {
      return;
    }

    try {
      const revalidated = await readFile(this.lockFile, "utf8");

      if (revalidated === source) {
        await rm(this.lockFile);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #syncDirectory() {
    let directoryHandle;

    try {
      directoryHandle = await open(path.dirname(this.stateFile), "r");
      await this.syncHandle(directoryHandle, "directory");
    } catch (error) {
      if (!unsupportedDirectorySync(error, this.platform)) {
        throw error;
      }
    } finally {
      await directoryHandle?.close();
    }
  }

  async #commit(state, hooks, operation) {
    await hooks.beforeCommit?.(state);

    const temporary = [
      this.stateFile,
      this.processId,
      this.id(),
      "tmp",
    ].join(".");

    try {
      const output = await open(temporary, "wx", 0o600);

      try {
        await output.writeFile(
          `${JSON.stringify(state, null, 2)}\n`,
          "utf8",
        );
        await this.syncHandle(output, "file");
      } finally {
        await output.close();
      }

      await rename(temporary, this.stateFile);
      await this.#syncDirectory();
    } catch (error) {
      throw this.#error(
        "LEDGER_WRITE_FAILED",
        operation,
        "The JSON state file could not be committed.",
        error,
      );
    } finally {
      await rm(temporary, { force: true });
    }

    await hooks.afterCommit?.(state);
    return state;
  }

  async #withLock(operation, callback) {
    const token = await this.#acquireLock(operation);

    try {
      return await callback();
    } finally {
      await this.#releaseLock(token);
    }
  }

  async initialize(initialState) {
    try {
      return await this.#read("initialize");
    } catch (error) {
      if (error.code !== "LEDGER_NOT_FOUND") {
        throw error;
      }
    }

    return this.#withLock("initialize", async () => {
      try {
        return await this.#read("initialize");
      } catch (error) {
        if (error.code !== "LEDGER_NOT_FOUND") {
          throw error;
        }
      }

      return this.#commit(initialState, {}, "initialize");
    });
  }

  async transact(transform, hooks = {}) {
    return this.#withLock("transact", async () => {
      const currentState = await this.#read("transact");
      const transformed = await transform(currentState);

      if (
        !transformed
        || typeof transformed !== "object"
        || !Object.hasOwn(transformed, "state")
      ) {
        throw new TypeError(
          "AtomicJsonStore transforms must return { state, result }.",
        );
      }

      if (transformed.commit === false) {
        await hooks.onNoCommit?.(currentState);
        return {
          state: currentState,
          result: transformed.result,
          committed: false,
        };
      }

      const committedState = await this.#commit(
        transformed.state,
        hooks,
        "transact",
      );

      return {
        state: committedState,
        result: transformed.result,
      };
    });
  }
}
