#!/usr/bin/env node

import { verifyDaemonCaller } from "./daemon-permissions.mjs";

import {
  randomBytes,
} from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import {
  ensureCodexAppServerHost,
} from "./codex-app-server-host.mjs";
import {
  openCodexAppServerWebSocket,
} from "./codex-app-server-websocket.mjs";

const MAX_OUTBOUND_FRAME_BYTES = 1 * 1_024 * 1_024;
const MAX_INBOUND_FRAME_BYTES = 32 * 1_024 * 1_024;

function bridgeError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "CodexAppServerBridgeError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function sizeLimitError(direction, receivedBytes, limitBytes) {
  const response = direction === "server-to-client";
  return bridgeError(
    response
      ? "APP_SERVER_RESPONSE_TOO_LARGE"
      : "APP_SERVER_REQUEST_TOO_LARGE",
    `Codex app-server ${response ? "response" : "request"} exceeds ${limitBytes} bytes`,
    {
      direction,
      receivedBytes,
      limitBytes,
    },
  );
}

function bridgeFailureMessage(error) {
  return {
    method: "codex-small-loop/bridge-error",
    params: {
      code: typeof error?.code === "string"
        ? error.code
        : "APP_SERVER_BRIDGE_FAILED",
      message: typeof error?.message === "string"
        ? error.message
        : "Codex app-server bridge failed",
      ...(typeof error?.direction === "string"
        ? { direction: error.direction }
        : {}),
      ...(Number.isSafeInteger(error?.receivedBytes)
        ? { receivedBytes: error.receivedBytes }
        : {}),
      ...(Number.isSafeInteger(error?.limitBytes)
        ? { limitBytes: error.limitBytes }
        : {}),
    },
  };
}

function requireHostEndpoint(host) {
  if (host?.endpoint === null || typeof host?.endpoint !== "object") {
    throw bridgeError(
      "APP_SERVER_HOST_RESPONSE_INVALID",
      "Codex Small Loop app-server host returned no endpoint",
    );
  }
  return host.endpoint;
}

function encodeClientFrame(
  value,
  opcode = 0x1,
  maxFrameBytes = MAX_OUTBOUND_FRAME_BYTES,
) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (payload.length > maxFrameBytes) {
    throw sizeLimitError(
      "client-to-server",
      payload.length,
      maxFrameBytes,
    );
  }
  const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const mask = randomBytes(4);
  const frame = Buffer.allocUnsafe(2 + extended + mask.length + payload.length);
  frame[0] = 0x80 | opcode;
  let offset = 2;
  if (extended === 0) {
    frame[1] = 0x80 | payload.length;
  } else if (extended === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), offset);
    offset += 8;
  }
  mask.copy(frame, offset);
  offset += mask.length;
  for (let index = 0; index < payload.length; index += 1) {
    frame[offset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

class ServerFrameReader {
  constructor({
    onText,
    onPing,
    onClose,
    maxFrameBytes = MAX_INBOUND_FRAME_BYTES,
  }) {
    this.onText = onText;
    this.onPing = onPing;
    this.onClose = onClose;
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.#take();
      if (!frame) {
        return;
      }
      this.#handle(frame);
    }
  }

  #take() {
    if (this.buffer.length < 2) {
      return null;
    }
    const first = this.buffer[0];
    const second = this.buffer[1];
    if ((second & 0x80) !== 0) {
      throw bridgeError(
        "APP_SERVER_BRIDGE_PROTOCOL_ERROR",
        "Codex app-server sent a masked WebSocket frame",
      );
    }
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > BigInt(this.maxFrameBytes)) {
        throw sizeLimitError(
          "server-to-client",
          Number(wide),
          this.maxFrameBytes,
        );
      }
      length = Number(wide);
      offset = 10;
    }
    if (length > this.maxFrameBytes) {
      throw sizeLimitError(
        "server-to-client",
        length,
        this.maxFrameBytes,
      );
    }
    if (this.buffer.length < offset + length) {
      return null;
    }
    const frame = {
      fin: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload: this.buffer.subarray(offset, offset + length),
    };
    this.buffer = this.buffer.subarray(offset + length);
    return frame;
  }

  #handle({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.onClose();
      return;
    }
    if (opcode === 0x9 && fin && payload.length <= 125) {
      this.onPing(payload);
      return;
    }
    if (opcode === 0xa) {
      return;
    }
    if (opcode === 0x1 && fin) {
      this.onText(payload);
      return;
    }
    if (opcode === 0x1 && !fin && this.fragments.length === 0) {
      this.fragments.push(payload);
      this.fragmentBytes = payload.length;
      return;
    }
    if (opcode === 0x0 && this.fragments.length > 0) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxFrameBytes) {
        throw sizeLimitError(
          "server-to-client",
          this.fragmentBytes,
          this.maxFrameBytes,
        );
      }
      if (fin) {
        this.onText(Buffer.concat(this.fragments, this.fragmentBytes));
        this.fragments = [];
        this.fragmentBytes = 0;
      }
      return;
    }
    throw bridgeError(
      "APP_SERVER_BRIDGE_PROTOCOL_ERROR",
      "Codex app-server sent an unsupported WebSocket frame",
    );
  }
}

function createInputReader(
  onLine,
  onError,
  maxFrameBytes = MAX_OUTBOUND_FRAME_BYTES,
) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += decoder.write(chunk);
    const receivedBytes = Buffer.byteLength(buffer);
    if (!buffer.includes("\n") && receivedBytes > maxFrameBytes) {
      onError(sizeLimitError(
        "client-to-server",
        receivedBytes,
        maxFrameBytes,
      ));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          onLine(line);
        } catch (error) {
          onError(error);
          return;
        }
      }
    }
  };
}

export async function runCodexAppServerBridge({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  ensureHost = ensureCodexAppServerHost,
  openWebSocket = openCodexAppServerWebSocket,
  maxInboundFrameBytes = MAX_INBOUND_FRAME_BYTES,
  maxOutboundFrameBytes = MAX_OUTBOUND_FRAME_BYTES,
} = {}) {
  const { socket, remainder } = await openWebSocket(
    requireHostEndpoint(await ensureHost()),
  );
  let detached = false;
  let ended = false;
  let failure;
  const pendingTurnStarts = new Set();
  const activeTurns = new Set();

  const finish = () => {
    ended = true;
    stdin.pause?.();
  };
  const closeWhenIdle = () => {
    if (
      detached
      && pendingTurnStarts.size === 0
      && activeTurns.size === 0
      && !ended
    ) {
      socket.write(encodeClientFrame(
        Buffer.alloc(0),
        0x8,
        maxOutboundFrameBytes,
      ));
      socket.end();
    }
  };
  const fail = (error) => {
    if (failure) return;
    failure = error;
    if (!detached) {
      stdout.write(`${JSON.stringify(bridgeFailureMessage(error))}\n`);
    }
    finish();
    socket.destroy();
  };
  const frames = new ServerFrameReader({
    onText(payload) {
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        message = null;
      }
      if (
        message
        && Object.hasOwn(message, "id")
        && pendingTurnStarts.has(message.id)
      ) {
        pendingTurnStarts.delete(message.id);
        if (typeof message.result?.turn?.id === "string") {
          activeTurns.add(message.result.turn.id);
        }
      }
      if (message?.method === "turn/completed") {
        activeTurns.delete(message.params?.turn?.id);
      }
      if (!detached) {
        stdout.write(payload);
        stdout.write("\n");
      }
      closeWhenIdle();
    },
    onPing(payload) {
      socket.write(encodeClientFrame(payload, 0xa, maxOutboundFrameBytes));
    },
    onClose() {
      finish();
      socket.end();
    },
    maxFrameBytes: maxInboundFrameBytes,
  });
  socket.on("data", (chunk) => {
    try {
      frames.push(chunk);
    } catch (error) {
      fail(error);
    }
  });
  socket.on("error", fail);
  socket.on("close", finish);
  if (remainder.length > 0) {
    try {
      frames.push(remainder);
    } catch (error) {
      fail(error);
    }
  }

  const readInput = createInputReader((line) => {
    try {
      const message = JSON.parse(line);
      if (
        message?.method === "turn/start"
        && Object.hasOwn(message, "id")
      ) {
        pendingTurnStarts.add(message.id);
      }
    } catch {
      // The app-server returns the authoritative JSON-RPC protocol error.
    }
    socket.write(encodeClientFrame(line, 0x1, maxOutboundFrameBytes));
  }, fail, maxOutboundFrameBytes);
  stdin.on("data", readInput);

  const detach = () => {
    if (detached) return;
    detached = true;
    if (process.connected) {
      process.send?.({ type: "detached" }, () => process.disconnect?.());
    }
    closeWhenIdle();
  };
  stdin.on("end", detach);
  process.on("message", (message) => {
    if (message?.type === "detach") detach();
  });

  await new Promise((resolve) => socket.once("close", resolve));
  if (failure) {
    throw failure;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  try {
    await verifyDaemonCaller();
    await runCodexAppServerBridge();
  } catch (error) {
    process.stderr.write(
      `${error?.code ?? "APP_SERVER_BRIDGE_FAILED"}: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  }
}
