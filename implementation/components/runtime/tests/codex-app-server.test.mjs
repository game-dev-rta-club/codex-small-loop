import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServerClient,
  CodexAppServerError,
} from "../source/codex-app-server.mjs";
import {
  runCodexAppServerBridge,
} from "../source/codex-app-server-bridge.mjs";

const HIGH_PROFILE = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  serviceTier: "priority",
});

function sandboxRunContext(profile = HIGH_PROFILE, overrides = {}) {
  return {
    ...profile,
    approvalPolicy: "never",
    permission: {
      type: "sandbox",
      policy: { type: "dangerFullAccess" },
    },
    ...overrides,
  };
}

const MOCK_SERVER = String.raw`
import fs from "node:fs";
import readline from "node:readline";

const scenario = process.env.MOCK_SCENARIO;
const transcript = process.env.MOCK_TRANSCRIPT;
const requests = new Map();
let turnStarts = [];
let resumeAttempts = 0;

function responseAuthority(params) {
  return params.permissions
    ? {
      approvalPolicy: params.approvalPolicy,
      sandbox: { type: "workspaceWrite" },
      activePermissionProfile: {
        id: params.permissions,
        extends: null,
      },
    }
    : {
      approvalPolicy: params.approvalPolicy,
      sandbox: {
        type: params.sandbox === "read-only"
          ? "readOnly"
          : params.sandbox === "workspace-write"
            ? "workspaceWrite"
            : "dangerFullAccess",
        ...(params.config?.sandbox_workspace_write ? {
          writableRoots: params.config.sandbox_workspace_write.writable_roots,
          networkAccess: params.config.sandbox_workspace_write.network_access,
          excludeSlashTmp: params.config.sandbox_workspace_write.exclude_slash_tmp,
          excludeTmpdirEnvVar: params.config.sandbox_workspace_write.exclude_tmpdir_env_var,
        } : {}),
      },
      activePermissionProfile: null,
    };
}

function record(message) {
  fs.appendFileSync(transcript, JSON.stringify(message) + "\n");
}

function write(message, mode = "normal") {
  const line = JSON.stringify(message) + "\n";
  if (mode === "partial") {
    const split = Math.max(1, Math.floor(line.length / 2));
    process.stdout.write(line.slice(0, split));
    setTimeout(() => process.stdout.write(line.slice(split)), 5);
    return;
  }
  process.stdout.write(line);
}

function respond(message, result, mode) {
  write({ id: message.id, result }, mode);
}

const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const message = JSON.parse(line);
  record(message);

  if (message.method === "initialized") return;

  if (scenario === "malformed" && message.method === "initialize") {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (scenario === "exit" && message.method === "initialize") {
    process.stderr.write("app-server failed\n");
    process.exit(7);
  }
  if (scenario === "timeout") return;

  if (message.method === "initialize") {
    if (scenario === "bridge-size-error") {
      write({
        method: "codex-small-loop/bridge-error",
        params: {
          code: "APP_SERVER_RESPONSE_TOO_LARGE",
          message: "Codex app-server response exceeds 33554432 bytes",
          direction: "server-to-client",
          receivedBytes: 33_554_433,
          limitBytes: 33_554_432,
        },
      });
      return;
    }
    respond(message, { userAgent: "mock" }, scenario === "partial" ? "partial" : "normal");
    return;
  }
  if (message.method === "thread/start") {
    if (scenario === "request-error") {
      write({
        id: message.id,
        error: { code: -32001, message: "Server overloaded; retry later." },
      });
      return;
    }
    respond(
      message,
      scenario === "missing-task"
        ? { thread: {} }
        : {
          thread: { id: "task-1" },
          ...responseAuthority(message.params),
          ...(scenario === "permission-mismatch"
            ? { sandbox: { type: "readOnly" } }
            : {}),
          model: message.params.model ?? "gpt-5.6-sol",
          reasoningEffort: scenario === "profile-missing-effort"
            ? undefined
            : scenario === "profile-mismatch"
              ? "high"
              : message.params.config?.model_reasoning_effort ?? "high",
          serviceTier: scenario === "profile-missing-service-tier"
            ? undefined
            : scenario === "profile-tier-mismatch"
              ? null
              : scenario === "profile-default-tier"
                ? "default"
              : message.params.serviceTier ?? null,
        },
    );
    return;
  }
  if (message.method === "thread/fork") {
    respond(
      message,
      scenario === "missing-task"
        ? {}
        : {
          thread: { id: "forked-task-1" },
          ...responseAuthority(message.params),
          model: message.params.model ?? "gpt-5.6-sol",
          reasoningEffort: scenario === "profile-missing-effort"
            ? undefined
            : scenario === "profile-mismatch"
              ? "high"
              : message.params.config?.model_reasoning_effort ?? "high",
          serviceTier: scenario === "profile-missing-service-tier"
            ? undefined
            : scenario === "profile-tier-mismatch"
              ? null
              : message.params.serviceTier ?? null,
        },
    );
    return;
  }
  if (message.method === "thread/name/set") {
    respond(message, {});
    return;
  }
  if (message.method === "thread/read") {
    const threadSource = scenario === "source-user"
      ? "user"
      : scenario === "source-null" || scenario === "source-null-path"
        ? null
        : "codex-small-loop";
    respond(message, {
      thread: {
        id: message.params.threadId,
        name: "Readable task name",
        threadSource,
        cwd: process.env.MOCK_CWD,
        path: process.env.MOCK_SESSION,
      },
    });
    return;
  }
  if (message.method === "thread/resume") {
    resumeAttempts += 1;
    if (scenario === "resume-rollout-race" && resumeAttempts === 1) {
      write({
        id: message.id,
        error: {
          code: -32600,
          message: "no rollout found for thread id " + message.params.threadId,
        },
      });
      return;
    }
    const hasOverrides = Object.hasOwn(message.params, "model")
      || Object.hasOwn(message.params, "serviceTier");
    const result = {
      thread: { id: message.params.threadId },
      cwd: scenario === "resume-other-cwd" ? "/other-project" : "/project",
      ...(hasOverrides
        ? responseAuthority(message.params)
        : {
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
          activePermissionProfile: null,
        }),
      model: message.params.model ?? "gpt-5.6-sol",
      reasoningEffort: message.params.config?.model_reasoning_effort ?? "high",
      serviceTier: scenario === "profile-missing-service-tier"
        ? undefined
        : hasOverrides
          ? message.params.serviceTier ?? null
          : "priority",
      activePermissionProfile: scenario === "resume-profile"
        ? { id: ":danger-full-access", extends: null }
        : hasOverrides
          ? responseAuthority(message.params).activePermissionProfile
          : null,
    };
    if (scenario === "resume-missing-permission") {
      delete result.approvalPolicy;
    }
    if (scenario === "profile-missing-effort") {
      delete result.reasoningEffort;
    }
    respond(message, result);
    return;
  }
  if (message.method === "turn/start") {
    if (scenario === "concurrent") {
      turnStarts.push(message);
      if (turnStarts.length === 2) {
        const [first, second] = turnStarts;
        process.stdout.write(
          JSON.stringify({ id: second.id, result: { turn: { id: "turn-2" } } })
          + "\n"
          + JSON.stringify({ id: first.id, result: { turn: { id: "turn-1" } } })
          + "\n",
        );
      }
      return;
    }
    const turnId = scenario === "missing-turn" ? null : "turn-1";
    respond(message, { turn: turnId ? { id: turnId } : {} });
    if (turnId && scenario !== "no-completion") {
      write({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: { id: turnId, status: "completed", items: [] },
        },
      });
    }
    return;
  }
  if (message.method === "turn/steer") {
    const errors = {
      "steer-no-active": "no active turn to steer",
      "steer-mismatch": "expected active turn id turn-1 but found turn-2",
      "steer-review": "cannot steer a review turn",
      "steer-compact": "cannot steer a compact turn",
    };
    if (errors[scenario]) {
      write({
        id: message.id,
        error: {
          code: -32600,
          message: errors[scenario],
          data: scenario.startsWith("steer-")
            ? { codexErrorInfo: "test" }
            : undefined,
        },
      });
      return;
    }
    respond(message, { turnId: message.params.expectedTurnId });
    return;
  }
  if (message.method === "turn/interrupt") {
    if (scenario === "no-active-turn") {
      write({
        id: message.id,
        error: { code: -32600, message: "no active turn to interrupt" },
      });
      return;
    }
    respond(message, {});
  }
});
`;

async function withMock(scenario, run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whole-job-app-server-"));
  const transcript = path.join(directory, "transcript.jsonl");
  await writeFile(transcript, "");
  const session = path.join(
    directory,
    "rollout-2026-07-28T00-00-00-existing-task.jsonl",
  );
  await writeFile(session, [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "existing-task",
        cwd: directory,
        thread_source: "codex-small-loop",
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        cwd: directory,
        model: "gpt-5.6-sol",
        effort: "medium",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
      },
    }),
    "",
  ].join("\n"));
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: ["--input-type=module", "--eval", MOCK_SERVER],
    cwd: directory,
    env: {
      ...process.env,
      MOCK_SCENARIO: scenario,
      MOCK_CWD: directory,
      MOCK_TRANSCRIPT: transcript,
      MOCK_SESSION: session,
    },
    timeoutMs: options.timeoutMs ?? 500,
    maxDiagnosticBytes: options.maxDiagnosticBytes,
    resumeRetryTimeoutMs: options.resumeRetryTimeoutMs,
    resumeRetryIntervalMs: options.resumeRetryIntervalMs,
    now: options.now,
    sleep: options.sleep,
    spawnProcess: options.spawnProcess,
  });

  try {
    await run({ client, directory, transcript });
  } finally {
    await client.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
  }
}

test("starts the App Server child without a shell or visible Windows window", async () => {
  let observed = null;
  await withMock("success", async ({ client }) => {
    await client.connect();
  }, {
    spawnProcess(command, args, options) {
      observed = { command, args, options };
      return spawnProcess(command, args, options);
    },
  });

  assert.equal(observed.command, process.execPath);
  assert.deepEqual(observed.args, ["--input-type=module", "--eval", MOCK_SERVER]);
  assert.equal(observed.options.detached, false);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(observed.options.windowsHide, true);
});

test("detaches the production Node bridge with its IPC channel intact", async () => {
  let observed = null;
  const client = new CodexAppServerClient({
    spawnProcess(command, args, options) {
      observed = { command, args, options };
      throw new Error("stop after observing production spawn options");
    },
  });

  await assert.rejects(
    client.connect(),
    (error) => error?.code === "APP_SERVER_START_FAILED",
  );
  assert.equal(observed.command, process.execPath);
  assert.equal(observed.args.length, 1);
  assert.match(observed.args[0], /codex-app-server-bridge\.mjs$/);
  assert.equal(observed.options.detached, true);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.stdio, ["pipe", "pipe", "pipe", "ipc"]);
  assert.equal(observed.options.windowsHide, true);
});

async function readTranscript(file) {
  const source = await readFile(file, "utf8");
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function websocketFrame(value) {
  const payload = Buffer.from(value);
  if (payload.length < 126) {
    return Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload,
    ]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function websocketHeaderForLength(length) {
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function takeClientFrame(buffer) {
  if (buffer.length < 6) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 8) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  assert.equal(masked, true);
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= mask[index % 4];
  }
  return {
    message: payload.toString("utf8"),
    remainder: buffer.subarray(offset + 4 + length),
  };
}

async function createMockWebSocketServer(directory, onMessage) {
  const socketPath = path.join(directory, "app-server.sock");
  const tokenPath = path.join(directory, "capability-token");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let handshake = Buffer.alloc(0);
    let frames = Buffer.alloc(0);
    let upgraded = false;

    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = handshake.subarray(0, end).toString("utf8");
        const key = header.match(/^Sec-WebSocket-Key: (.+)$/im)?.[1]?.trim();
        assert.ok(key);
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"));
        upgraded = true;
        frames = handshake.subarray(end + 4);
      } else {
        frames = Buffer.concat([frames, chunk]);
      }

      for (;;) {
        const frame = takeClientFrame(frames);
        if (!frame) return;
        frames = frame.remainder;
        if (frame.message.length > 0) {
          onMessage(JSON.parse(frame.message), {
            send(message) {
              socket.write(websocketFrame(JSON.stringify(message)));
            },
            sendRaw(buffer) {
              socket.write(buffer);
            },
          });
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (process.platform === "win32") {
      server.listen(0, "127.0.0.1", resolve);
    } else {
      server.listen(socketPath, resolve);
    }
  });
  const address = server.address();
  const endpoint = process.platform === "win32"
    ? {
      type: "loopback-websocket",
      url: `ws://127.0.0.1:${address.port}`,
      tokenPath,
    }
    : { type: "unix", socketPath };
  if (process.platform === "win32") {
    await writeFile(tokenPath, "a".repeat(43), "utf8");
  }
  return {
    endpoint,
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("initializes once and maps normalized task, turn, wait, and interrupt operations", async () => {
  await withMock("success", async ({ client, transcript }) => {
    await client.connect();
    const created = await client.createTask({
      cwd: "/project",
      runContext: sandboxRunContext(),
    });
    const started = await client.startTurn({
      taskId: created.taskId,
      text: "Bootstrap",
      cwd: "/project",
      runContext: created.runContext,
    });
    const observation = await client.waitForTurn({
      taskId: created.taskId,
      turnId: started.turnId,
      timeoutMs: 200,
    });
    const interrupted = await client.interruptTurn({
      taskId: created.taskId,
      turnId: started.turnId,
    });

    assert.deepEqual(created, {
      taskId: "task-1",
      runContext: sandboxRunContext(),
    });
    assert.deepEqual(started, { turnId: "turn-1" });
    assert.deepEqual(observation, {
      taskId: "task-1",
      turnId: "turn-1",
      status: "completed",
    });
    assert.deepEqual(interrupted, {
      taskId: "task-1",
      turnId: "turn-1",
      interrupted: true,
    });

    const messages = await readTranscript(transcript);
    assert.deepEqual(
      messages.map((message) => message.method),
      [
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "turn/interrupt",
      ],
    );
    assert.deepEqual(messages[2].params, {
      cwd: "/project",
      model: "gpt-5.6-sol",
      config: {
        model_reasoning_effort: "high",
      },
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      threadSource: "codex-small-loop",
    });
    assert.deepEqual(messages[3].params, {
      threadId: "task-1",
      input: [{ type: "text", text: "Bootstrap" }],
      cwd: "/project",
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    assert.deepEqual(messages[4].params, {
      threadId: "task-1",
      turnId: "turn-1",
    });
  });
});

test("creates one task with an explicit execution profile", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const created = await client.createTask({
      cwd: "/project",
      runContext: sandboxRunContext({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: "priority",
      }),
    });

    assert.deepEqual(created, {
      taskId: "task-1",
      runContext: sandboxRunContext({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: "priority",
      }),
    });
    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/start");
    assert.deepEqual(request.params, {
      cwd: "/project",
      model: "gpt-5.6-sol",
      config: {
        model_reasoning_effort: "medium",
      },
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      threadSource: "codex-small-loop",
    });
  });
});

test("treats Codex default tier as the requested normal tier", async () => {
  await withMock("profile-default-tier", async ({ client, transcript }) => {
    const created = await client.createTask({
      cwd: "/project",
      runContext: sandboxRunContext({
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        serviceTier: null,
      }),
    });

    assert.deepEqual(created, {
      taskId: "task-1",
      runContext: sandboxRunContext({
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        serviceTier: null,
      }),
    });
    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/start");
    assert.equal(request.params.serviceTier, null);
  });
});

test("fails closed when Codex omits or changes the service tier", async () => {
  await withMock("profile-missing-service-tier", async ({ client }) => {
    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext({
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          serviceTier: "priority",
        }),
      }),
      (error) => error.code === "APP_SERVER_RESPONSE_INVALID",
    );
  });

  await withMock("profile-tier-mismatch", async ({ client }) => {
    await assert.rejects(
      client.forkTask({
        taskId: "parent-1",
        cwd: "/project",
        runContext: sandboxRunContext({
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          serviceTier: "priority",
        }),
      }),
      (error) => error.code === "TASK_EXECUTION_PROFILE_MISMATCH"
        && error.expectedProfile.serviceTier === "priority"
        && error.actualProfile.serviceTier === null,
    );
  });
});

test("forks one task with an explicit execution profile", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const forked = await client.forkTask({
      taskId: "parent-task",
      cwd: "/project",
      runContext: sandboxRunContext({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: "priority",
      }),
    });

    assert.deepEqual(forked, {
      taskId: "forked-task-1",
      runContext: sandboxRunContext({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: "priority",
      }),
    });
    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/fork");
    assert.deepEqual(request.params, {
      threadId: "parent-task",
      cwd: "/project",
      model: "gpt-5.6-sol",
      config: {
        model_reasoning_effort: "medium",
      },
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      threadSource: "codex-small-loop",
    });
  });
});

test("forks with a named permission profile and no sandbox override", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const runContext = {
      ...HIGH_PROFILE,
      approvalPolicy: "on-request",
      permission: {
        type: "profile",
        id: ":danger-full-access",
      },
    };
    assert.deepEqual(await client.forkTask({
      taskId: "parent-task",
      cwd: "/project",
      runContext,
    }), {
      taskId: "forked-task-1",
      runContext,
    });

    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/fork");
    assert.equal(request.params.approvalPolicy, "on-request");
    assert.equal(request.params.permissions, ":danger-full-access");
    assert.equal(Object.hasOwn(request.params, "sandbox"), false);
  });
});

test("fails closed when Codex creates a different execution profile", async () => {
  await withMock("profile-mismatch", async ({ client }) => {
    const expected = (error) =>
      error instanceof CodexAppServerError
      && error.code === "TASK_EXECUTION_PROFILE_MISMATCH"
      && error.expectedProfile.reasoningEffort === "medium"
      && error.actualProfile.reasoningEffort === "high";

    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext({
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          serviceTier: "priority",
        }),
      }),
      expected,
    );
    await assert.rejects(
      client.forkTask({
        taskId: "parent-1",
        cwd: "/project",
        runContext: sandboxRunContext({
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          serviceTier: "priority",
        }),
      }),
      expected,
    );
  });
});

test("fails closed when Codex creates a task with different authority", async () => {
  await withMock("permission-mismatch", async ({ client }) => {
    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext(),
      }),
      (error) => error instanceof CodexAppServerError
        && error.code === "TASK_RUN_CONTEXT_MISMATCH"
        && error.expectedContext.permission.policy.type === "dangerFullAccess"
        && error.actualContext.permission.policy.type === "readOnly",
    );
  });
});

test("fails before creation when sandbox authority would lose details", async () => {
  await withMock("success", async ({ client, transcript }) => {
    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext(HIGH_PROFILE, {
          permission: {
            type: "sandbox",
            policy: {
              type: "workspaceWrite",
              writableRoots: ["/project"],
              customRestriction: true,
            },
          },
        }),
      }),
      (error) => error.code === "DAEMON_FULL_ACCESS_REQUIRED",
    );
    assert.equal(
      (await readTranscript(transcript))
        .some(({ method }) => method === "thread/start"),
      false,
    );
  });
});

test("distinguishes a missing reasoning field from a confirmed null effort", async () => {
  await withMock("profile-missing-effort", async ({ client }) => {
    const expected = (error) =>
      error instanceof CodexAppServerError
      && error.code === "APP_SERVER_RESPONSE_INVALID";

    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext({
          model: "gpt-5.6-sol",
          reasoningEffort: null,
          serviceTier: "priority",
        }),
      }),
      expected,
    );
    await assert.rejects(
      client.resumeTask({ taskId: "parent-1" }),
      expected,
    );
  });
});

test("sets one durable Codex Task name", async () => {
  await withMock("success", async ({ client, transcript }) => {
    assert.deepEqual(
      await client.setTaskName({
        taskId: "task-1",
        name: "sum-one-to-ten",
      }),
      {
        taskId: "task-1",
        name: "sum-one-to-ten",
      },
    );
    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/name/set");
    assert.deepEqual(request.params, {
      threadId: "task-1",
      name: "sum-one-to-ten",
    });
  });
});

test("rejects a fork response without a durable Child Task ID", async () => {
  await withMock("missing-task", async ({ client }) => {
    await assert.rejects(
      client.forkTask({
        taskId: "parent-task",
        cwd: "/project",
        runContext: sandboxRunContext(),
      }),
      (error) => error.code === "APP_SERVER_RESPONSE_INVALID"
        && error.operation === "forkTask",
    );
  });
});

test("steers the exact active turn and normalizes semantic rejections", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const steered = await client.steerTurn({
      taskId: "existing-task",
      turnId: "turn-1",
      text: "Updated direction",
      cwd: "/project",
    });
    assert.deepEqual(steered, { turnId: "turn-1" });
    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "turn/steer");
    assert.deepEqual(request.params, {
      threadId: "existing-task",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Updated direction" }],
    });
  });

  for (const [scenario, code, turnKind] of [
    ["steer-no-active", "APP_SERVER_STEER_NO_ACTIVE_TURN"],
    ["steer-mismatch", "APP_SERVER_STEER_TURN_MISMATCH"],
    ["steer-review", "APP_SERVER_STEER_NOT_STEERABLE", "review"],
    ["steer-compact", "APP_SERVER_STEER_NOT_STEERABLE", "compact"],
  ]) {
    await withMock(scenario, async ({ client }) => {
      await assert.rejects(
        client.steerTurn({
          taskId: "existing-task",
          turnId: "turn-1",
          text: "Updated direction",
          cwd: "/project",
        }),
        (error) => error.code === code
          && (turnKind === undefined || error.turnKind === turnKind)
          && error.rpcCode === -32600,
      );
    });
  }
});

test("resumes an existing task before starting or interrupting its turns", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const started = await client.startTurn({
      taskId: "existing-task",
      text: "Continue",
      cwd: "/project",
      runContext: sandboxRunContext(),
    });
    await client.interruptTurn({
      taskId: "existing-task",
      turnId: started.turnId,
    });

    const messages = await readTranscript(transcript);
    assert.deepEqual(
      messages.map((message) => message.method),
      [
        "initialize",
        "initialized",
        "thread/resume",
        "turn/start",
        "turn/interrupt",
      ],
    );
    assert.deepEqual(messages[2].params, {
      threadId: "existing-task", excludeTurns: true,
      model: "gpt-5.6-sol", config: { model_reasoning_effort: "high" },
      serviceTier: "priority", approvalPolicy: "never", sandbox: "danger-full-access",
    });
    assert.deepEqual(messages[3].params, {
      threadId: "existing-task",
      input: [{ type: "text", text: "Continue" }],
      cwd: "/project",
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });
});

test("reads task name and threadSource without loading turns or resuming the task", async () => {
  await withMock("source-user", async ({ client, transcript }) => {
    assert.deepEqual(await client.readTask({
      taskId: "existing-task",
    }), {
      taskId: "existing-task",
      name: "Readable task name",
      threadSource: "user",
    });

    const messages = await readTranscript(transcript);
    assert.deepEqual(
      messages.map((message) => message.method),
      ["initialize", "initialized", "thread/read"],
    );
    assert.deepEqual(messages[2].params, {
      threadId: "existing-task",
      includeTurns: false,
    });
  });
});

test("recovers missing threadSource from the Task session metadata", async () => {
  await withMock("source-null-path", async ({ client, transcript }) => {
    assert.deepEqual(await client.readTask({
      taskId: "existing-task",
    }), {
      taskId: "existing-task",
      name: "Readable task name",
      threadSource: "codex-small-loop",
    });

    const messages = await readTranscript(transcript);
    assert.deepEqual(
      messages.map((message) => message.method),
      ["initialize", "initialized", "thread/read"],
    );
  });
});

test("loads persisted authority before the first resume when context is omitted", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const result = await client.resumeTask({ taskId: "existing-task" });
    assert.equal(result.runContext.permission.policy.type, "dangerFullAccess");
    const messages = await readTranscript(transcript);
    assert.ok(messages.findIndex(x => x.method === "thread/read") < messages.findIndex(x => x.method === "thread/resume"));
    const request = messages.find(x => x.method === "thread/resume");
    assert.equal(request.params.sandbox, "danger-full-access");
    assert.equal(request.params.approvalPolicy, "never");
  });
});

test("retries the bounded rollout visibility race while resuming a new task", async () => {
  await withMock("resume-rollout-race", async ({ client, transcript }) => {
    assert.equal((await client.resumeTask({
      taskId: "new-task",
      runContext: sandboxRunContext(),
    })).taskId, "new-task");

    const messages = await readTranscript(transcript);
    assert.equal(
      messages.filter(({ method }) => method === "thread/resume").length,
      2,
    );
  }, {
    resumeRetryTimeoutMs: 100,
    resumeRetryIntervalMs: 1,
    sleep: async () => {},
  });
});

test("preserves the requested execution profile while resuming a task", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const runContext = sandboxRunContext();

    assert.deepEqual(await client.resumeTask({
      taskId: "existing-task",
      runContext,
    }), {
      taskId: "existing-task",
      cwd: path.normalize("/project"),
      runContext,
    });

    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/resume");
    assert.deepEqual(request.params, {
      threadId: "existing-task",
      excludeTurns: true,
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "high" },
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });
});

test("preserves default tier and named authority while resuming a task", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const runContext = sandboxRunContext({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
    }, {
      permission: {
        type: "profile",
        id: ":danger-full-access",
      },
    });

    assert.deepEqual(await client.resumeTask({
      taskId: "existing-task",
      runContext,
    }), {
      taskId: "existing-task",
      cwd: path.normalize("/project"),
      runContext,
    });

    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "thread/resume");
    assert.deepEqual(request.params, {
      threadId: "existing-task",
      excludeTurns: true,
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "medium" },
      serviceTier: null,
      approvalPolicy: "never",
      permissions: ":danger-full-access",
    });
  });
});

test("reads the persisted execution profile without resuming or acquiring a writer", async () => {
  await withMock("profile-read", async ({ client, directory, transcript }) => {
    assert.deepEqual(await client.readTaskProfile({
      taskId: "existing-task",
    }), {
      taskId: "existing-task",
      cwd: directory,
      runContext: {
        approvalPolicy: "never",
        permission: {
          type: "sandbox",
          policy: { type: "dangerFullAccess" },
        },
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: null,
      },
    });

    const messages = await readTranscript(transcript);
    assert.deepEqual(
      messages.map(({ method }) => method),
      ["initialize", "initialized", "thread/read"],
    );
  });
});

test("fails closed when metadata-only resume omits active permissions", async () => {
  await withMock("resume-missing-permission", async ({ client }) => {
    await assert.rejects(
      client.resumeTask({ taskId: "existing-task" }),
      (error) => error.code === "TASK_PERMISSION_UNKNOWN"
        && error.operation === "resumeTask",
    );
  });
});

test("starts a turn with a named permission profile without sandbox override", async () => {
  await withMock("success", async ({ client, transcript }) => {
    await client.startTurn({
      taskId: "existing-task",
      text: "Continue",
      cwd: "/project",
      runContext: {
        ...HIGH_PROFILE,
        approvalPolicy: "never",
        permission: {
          type: "profile",
          id: ":danger-full-access",
        },
      },
    });

    const request = (await readTranscript(transcript))
      .find(({ method }) => method === "turn/start");
    assert.deepEqual(request.params, {
      threadId: "existing-task",
      input: [{ type: "text", text: "Continue" }],
      cwd: "/project",
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
      approvalPolicy: "never",
      permissions: ":danger-full-access",
    });
  });
});

test("opts into metadata-only resume during initialization", async () => {
  await withMock("success", async ({ client, transcript }) => {
    await client.startTurn({
      taskId: "existing-task",
      text: "Continue",
      cwd: "/project",
      runContext: sandboxRunContext(),
    });

    const messages = await readTranscript(transcript);
    assert.deepEqual(messages[0].params.capabilities, {
      experimentalApi: true,
    });
    assert.equal(messages[2].params.excludeTurns, true);
  });
});

test("treats an already inactive turn as an interrupt no-op", async () => {
  await withMock("no-active-turn", async ({ client }) => {
    assert.deepEqual(
      await client.interruptTurn({
        taskId: "existing-task",
        turnId: "finished-turn",
      }),
      {
        taskId: "existing-task",
        turnId: "finished-turn",
        interrupted: false,
      },
    );
  });
});

test("handles partial stdout frames", async () => {
  await withMock("partial", async ({ client }) => {
    await client.connect();
    assert.deepEqual(
      await client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext(),
      }),
      {
        taskId: "task-1",
        runContext: sandboxRunContext(),
      },
    );
  });
});

test("correlates concurrent responses received in reverse order", async () => {
  await withMock("concurrent", async ({ client }) => {
    await client.connect();
    const first = client.startTurn({
      taskId: "task-1",
      text: "First",
      cwd: "/project",
      runContext: sandboxRunContext(),
    });
    const second = client.startTurn({
      taskId: "task-1",
      text: "Second",
      cwd: "/project",
      runContext: sandboxRunContext(),
    });

    assert.deepEqual(await first, { turnId: "turn-1" });
    assert.deepEqual(await second, { turnId: "turn-2" });
  });
});

test("rejects malformed protocol frames with a bounded typed error", async () => {
  await withMock("malformed", async ({ client }) => {
    await assert.rejects(
      client.connect(),
      (error) => error instanceof CodexAppServerError
        && error.code === "APP_SERVER_PROTOCOL_ERROR"
        && error.operation === "initialize"
        && error.message.length <= 512,
    );
  });
});

test("propagates structured bridge size failures without waiting for timeout", async () => {
  await withMock("bridge-size-error", async ({ client }) => {
    await assert.rejects(
      client.connect(),
      (error) => error instanceof CodexAppServerError
        && error.code === "APP_SERVER_RESPONSE_TOO_LARGE"
        && error.operation === "initialize"
        && error.direction === "server-to-client"
        && error.receivedBytes === 33_554_433
        && error.limitBytes === 33_554_432,
    );
  });
});

test("normalizes app-server request errors without exposing raw frames", async () => {
  await withMock("request-error", async ({ client }) => {
    await client.connect();
    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext(),
      }),
      (error) => error instanceof CodexAppServerError
        && error.code === "APP_SERVER_REQUEST_FAILED"
        && error.operation === "createTask"
        && error.rpcCode === -32001
        && !error.message.includes('"jsonrpc"'),
    );
  });
});

test("rejects missing task and turn identifiers", async () => {
  await withMock("missing-task", async ({ client }) => {
    await client.connect();
    await assert.rejects(
      client.createTask({
        cwd: "/project",
        runContext: sandboxRunContext(),
      }),
      (error) => error.code === "APP_SERVER_RESPONSE_INVALID"
        && error.operation === "createTask",
    );
  });

  await withMock("missing-turn", async ({ client }) => {
    await client.connect();
    await assert.rejects(
      client.startTurn({
        taskId: "task-1",
        text: "Bootstrap",
        cwd: "/project",
        runContext: sandboxRunContext(),
      }),
      (error) => error.code === "APP_SERVER_RESPONSE_INVALID"
        && error.operation === "startTurn",
    );
  });
});

test("times out requests and completion waits independently", async () => {
  await withMock("timeout", async ({ client }) => {
    await assert.rejects(
      client.connect(),
      (error) => error.code === "APP_SERVER_TIMEOUT"
        && error.operation === "initialize",
    );
  }, { timeoutMs: 30 });

  await withMock("no-completion", async ({ client }) => {
    await client.connect();
    const { turnId } = await client.startTurn({
      taskId: "task-1",
      text: "Bootstrap",
      cwd: "/project",
      runContext: sandboxRunContext(),
    });
    await assert.rejects(
      client.waitForTurn({
        taskId: "task-1",
        turnId,
        timeoutMs: 30,
      }),
      (error) => error.code === "APP_SERVER_TIMEOUT"
        && error.operation === "waitForTurn",
    );
  });
});

test("bounds stderr when the process exits unexpectedly", async () => {
  await withMock("exit", async ({ client }) => {
    await assert.rejects(
      client.connect(),
      (error) => error.code === "APP_SERVER_EXITED"
        && error.operation === "initialize"
        && error.stderr === "app-serv",
    );
  }, { maxDiagnosticBytes: 8 });
});

test("detached bridge keeps an accepted turn connected until completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whole-job-bridge-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  let resolveTurnAccepted;
  let rejectTurnAccepted;
  const turnAccepted = new Promise((resolve, reject) => {
    resolveTurnAccepted = resolve;
    rejectTurnAccepted = reject;
  });
  const acceptanceTimeout = setTimeout(() => {
    rejectTurnAccepted(new Error("Timed out waiting for accepted turn response"));
  }, 2_000);
  stdout.on("data", (chunk) => {
    output.push(chunk.toString("utf8"));
    if (output.join("").includes('"turn-bridge"')) {
      clearTimeout(acceptanceTimeout);
      resolveTurnAccepted();
    }
  });
  let completeTurn;
  const server = await createMockWebSocketServer(
    directory,
    (message, connection) => {
      if (message.method === "initialize") {
        connection.send({ id: message.id, result: { userAgent: "mock" } });
      } else if (message.method === "turn/start") {
        connection.send({
          id: message.id,
          result: { turn: { id: "turn-bridge" } },
        });
        completeTurn = () => connection.send({
          method: "turn/completed",
          params: {
            threadId: "task-bridge",
            turn: {
              id: "turn-bridge",
              status: "completed",
              items: [],
            },
          },
        });
      }
    },
  );

  try {
    let settled = false;
    const bridge = runCodexAppServerBridge({
      stdin,
      stdout,
      stderr,
      ensureHost: async () => ({
        endpoint: server.endpoint,
      }),
    }).finally(() => {
      settled = true;
    });
    stdin.write('{"id":1,"method":"initialize","params":{}}\n');
    stdin.write(
      '{"id":2,"method":"turn/start","params":{"threadId":"task-bridge"}}\n',
    );

    await turnAccepted;
    assert.match(output.join(""), /"turn-bridge"/);
    const inputEnded = once(stdin, "end");
    stdin.end();
    await inputEnded;
    assert.equal(settled, false);

    completeTurn();
    await bridge;
    assert.equal(stderr.read()?.toString("utf8") ?? "", "");
  } finally {
    clearTimeout(acceptanceTimeout);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge accepts legitimate server responses larger than 256 KiB", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whole-job-bridge-large-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const padding = "x".repeat(512 * 1_024);
  const server = await createMockWebSocketServer(
    directory,
    (message, connection) => {
      connection.send({
        id: message.id,
        result: { thread: { id: "large-task" }, padding },
      });
    },
  );

  try {
    const bridge = runCodexAppServerBridge({
      stdin,
      stdout,
      stderr,
      ensureHost: async () => ({
        endpoint: server.endpoint,
      }),
    });
    const received = new Promise((resolve) => {
      stdout.on("data", () => {
        if (output.join("").includes("\n")) resolve();
      });
    });
    stdin.write('{"id":1,"method":"thread/resume","params":{}}\n');
    await received;
    stdin.end();
    await bridge;

    const response = JSON.parse(output.join("").trim());
    assert.equal(response.result.thread.id, "large-task");
    assert.equal(response.result.padding.length, padding.length);
    assert.equal(stderr.read()?.toString("utf8") ?? "", "");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge reports server responses above 32 MiB with structured size details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whole-job-bridge-limit-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const limitBytes = 32 * 1_024 * 1_024;
  const receivedBytes = limitBytes + 1;
  const server = await createMockWebSocketServer(
    directory,
    (_message, connection) => {
      connection.sendRaw(websocketHeaderForLength(receivedBytes));
    },
  );

  try {
    const bridge = runCodexAppServerBridge({
      stdin,
      stdout,
      stderr,
      ensureHost: async () => ({
        endpoint: server.endpoint,
      }),
    });
    stdin.write('{"id":1,"method":"thread/resume","params":{}}\n');

    await assert.rejects(
      bridge,
      (error) => error.code === "APP_SERVER_RESPONSE_TOO_LARGE"
        && error.direction === "server-to-client"
        && error.receivedBytes === receivedBytes
        && error.limitBytes === limitBytes,
    );
    stdin.end();
    assert.deepEqual(JSON.parse(output.join("").trim()), {
      method: "codex-small-loop/bridge-error",
      params: {
        code: "APP_SERVER_RESPONSE_TOO_LARGE",
        message: `Codex app-server response exceeds ${limitBytes} bytes`,
        direction: "server-to-client",
        receivedBytes,
        limitBytes,
      },
    });
    assert.equal(stderr.read()?.toString("utf8") ?? "", "");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge reports client requests above 1 MiB with structured size details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whole-job-bridge-request-limit-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const limitBytes = 1 * 1_024 * 1_024;
  const receivedBytes = limitBytes + 1;
  const server = await createMockWebSocketServer(
    directory,
    () => {
      assert.fail("oversized request must not reach Codex app-server");
    },
  );

  try {
    const bridge = runCodexAppServerBridge({
      stdin,
      stdout,
      stderr,
      ensureHost: async () => ({
        endpoint: server.endpoint,
      }),
    });
    stdin.write(`${"x".repeat(receivedBytes)}\n`);

    await assert.rejects(
      bridge,
      (error) => error.code === "APP_SERVER_REQUEST_TOO_LARGE"
        && error.direction === "client-to-server"
        && error.receivedBytes === receivedBytes
        && error.limitBytes === limitBytes,
    );
    stdin.end();
    assert.deepEqual(JSON.parse(output.join("").trim()), {
      method: "codex-small-loop/bridge-error",
      params: {
        code: "APP_SERVER_REQUEST_TOO_LARGE",
        message: `Codex app-server request exceeds ${limitBytes} bytes`,
        direction: "client-to-server",
        receivedBytes,
        limitBytes,
      },
    });
    assert.equal(stderr.read()?.toString("utf8") ?? "", "");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restricted fork fails before acquiring a writer", async () => {
  await withMock("success", async ({ client, transcript }) => {
    const context = sandboxRunContext(HIGH_PROFILE, { permission: {
      type: "sandbox", policy: { type: "workspaceWrite" },
    } });
    await assert.rejects(client.forkTask({ taskId: "parent-task", cwd: "/project", runContext: context }),
      { code: "DAEMON_FULL_ACCESS_REQUIRED" });
    assert.equal((await readTranscript(transcript)).some(x => x.method === "thread/fork"), false);
  });
});
