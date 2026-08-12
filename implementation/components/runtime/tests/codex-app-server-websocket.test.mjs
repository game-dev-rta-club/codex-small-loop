import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeCodexAppServerEndpoint,
  openCodexAppServerWebSocket,
} from "../source/codex-app-server-websocket.mjs";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

test("opens an authenticated IPv4 loopback WebSocket without exposing the token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "csl-websocket-test-"));
  const tokenPath = path.join(directory, "capability-token");
  const token = "a".repeat(43);
  await writeFile(tokenPath, token, "utf8");
  let requestHeader = "";
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      requestHeader = chunk.toString("utf8");
      const key = requestHeader.match(/^Sec-WebSocket-Key: (.+)$/im)?.[1]?.trim();
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const endpoint = {
      type: "loopback-websocket",
      url: `ws://127.0.0.1:${address.port}`,
      tokenPath,
    };
    const opened = await openCodexAppServerWebSocket(endpoint);
    assert.deepEqual(opened.endpoint, endpoint);
    assert.match(requestHeader, /^GET \/rpc HTTP\/1\.1$/m);
    assert.match(requestHeader, new RegExp(`^Authorization: Bearer ${token}$`, "m"));
    opened.socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-loopback, credentialed, and path-bearing WebSocket endpoints", () => {
  for (const url of [
    "ws://0.0.0.0:1234",
    "ws://localhost:1234",
    "ws://user@127.0.0.1:1234",
    "ws://127.0.0.1:1234/rpc",
  ]) {
    assert.throws(
      () => normalizeCodexAppServerEndpoint({
        type: "loopback-websocket",
        url,
        tokenPath: path.resolve("capability-token"),
      }),
      (error) => error.code === "APP_SERVER_ENDPOINT_INVALID",
    );
  }
});

test("rejects short capability tokens before opening a network connection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "csl-websocket-test-"));
  const tokenPath = path.join(directory, "capability-token");
  await writeFile(tokenPath, "short", "utf8");
  try {
    await assert.rejects(
      openCodexAppServerWebSocket({
        type: "loopback-websocket",
        url: "ws://127.0.0.1:1234",
        tokenPath,
      }),
      (error) => error.code === "APP_SERVER_TOKEN_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds stalled WebSocket connect and handshake establishment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "csl-websocket-test-"));
  const tokenPath = path.join(directory, "capability-token");
  await writeFile(tokenPath, "a".repeat(43), "utf8");
  const endpoint = {
    type: "loopback-websocket",
    url: "ws://127.0.0.1:1234",
    tokenPath,
  };
  class StalledSocket extends EventEmitter {
    write() {}
    destroy() { this.destroyed = true; }
  }
  const stalled = new StalledSocket();
  try {
    await assert.rejects(
      openCodexAppServerWebSocket(endpoint, {
        connect: () => stalled,
        timeoutMs: 20,
      }),
      (error) => error.code === "APP_SERVER_WEBSOCKET_CONNECT_FAILED",
    );
    assert.equal(stalled.destroyed, true);

    const connections = new Set();
    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        openCodexAppServerWebSocket({
          ...endpoint,
          url: `ws://127.0.0.1:${server.address().port}`,
        }, { timeoutMs: 20 }),
        (error) => error.code === "APP_SERVER_WEBSOCKET_HANDSHAKE_FAILED",
      );
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
