import {
  createHash,
  randomBytes,
} from "node:crypto";
import { open as openFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAX_HANDSHAKE_BYTES = 16 * 1_024;
const MAX_TOKEN_BYTES = 1_024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexAppServerWebSocketError";
  error.code = code;
  return error;
}

function normalizeLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw websocketError(
      "APP_SERVER_ENDPOINT_INVALID",
      "The Codex app-server WebSocket endpoint is invalid.",
      cause,
    );
  }
  const port = Number(url.port);
  if (
    url.protocol !== "ws:"
    || url.hostname !== "127.0.0.1"
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || url.username !== ""
    || url.password !== ""
    || (url.pathname !== "" && url.pathname !== "/")
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw websocketError(
      "APP_SERVER_ENDPOINT_INVALID",
      "The Codex app-server WebSocket endpoint must be an exact IPv4 loopback origin.",
    );
  }
  return `ws://127.0.0.1:${port}`;
}

export function normalizeCodexAppServerEndpoint(
  endpoint,
  { pathApi = path } = {},
) {
  if (endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw websocketError(
      "APP_SERVER_ENDPOINT_INVALID",
      "The Codex app-server endpoint is invalid.",
    );
  }
  if (endpoint.type === "unix") {
    if (
      typeof endpoint.socketPath !== "string"
      || !pathApi.isAbsolute(endpoint.socketPath)
    ) {
      throw websocketError(
        "APP_SERVER_ENDPOINT_INVALID",
        "The Codex app-server Unix socket path must be absolute.",
      );
    }
    return Object.freeze({
      type: "unix",
      socketPath: pathApi.normalize(endpoint.socketPath),
    });
  }
  if (endpoint.type === "loopback-websocket") {
    if (
      typeof endpoint.url !== "string"
      || typeof endpoint.tokenPath !== "string"
      || !pathApi.isAbsolute(endpoint.tokenPath)
    ) {
      throw websocketError(
        "APP_SERVER_ENDPOINT_INVALID",
        "The Codex app-server loopback endpoint is invalid.",
      );
    }
    return Object.freeze({
      type: "loopback-websocket",
      url: normalizeLoopbackUrl(endpoint.url),
      tokenPath: pathApi.normalize(endpoint.tokenPath),
    });
  }
  throw websocketError(
    "APP_SERVER_ENDPOINT_INVALID",
    "The Codex app-server endpoint type is unsupported.",
  );
}

async function readBearerToken(tokenPath, open = openFile) {
  let handle;
  try {
    handle = await open(tokenPath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_TOKEN_BYTES) {
      throw websocketError(
        "APP_SERVER_TOKEN_INVALID",
        "The Codex app-server capability token file is invalid.",
      );
    }
    const token = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{32,1024}$/.test(token)) {
      throw websocketError(
        "APP_SERVER_TOKEN_INVALID",
        "The Codex app-server capability token is invalid.",
      );
    }
    return token;
  } catch (cause) {
    if (cause?.code === "APP_SERVER_TOKEN_INVALID") throw cause;
    throw websocketError(
      "APP_SERVER_TOKEN_UNAVAILABLE",
      "The Codex app-server capability token could not be read.",
      cause,
    );
  } finally {
    await handle?.close();
  }
}

async function connectEndpoint(endpoint, connect, timeoutMs) {
  const options = endpoint.type === "unix"
    ? endpoint.socketPath
    : {
      host: "127.0.0.1",
      port: Number(new URL(endpoint.url).port),
    };
  return new Promise((resolve, reject) => {
    const socket = connect(options);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(websocketError(
        "APP_SERVER_WEBSOCKET_CONNECT_FAILED",
        "The Codex app-server connection timed out.",
      ));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (cause) => {
      cleanup();
      socket.destroy();
      reject(cause);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export async function openCodexAppServerWebSocket(
  input,
  {
    connect = net.createConnection,
    openToken = openFile,
    maxHandshakeBytes = MAX_HANDSHAKE_BYTES,
    timeoutMs = 10_000,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  const endpoint = normalizeCodexAppServerEndpoint(input);
  const token = endpoint.type === "loopback-websocket"
    ? await readBearerToken(endpoint.tokenPath, openToken)
    : null;
  let socket;
  try {
    socket = await connectEndpoint(endpoint, connect, timeoutMs);
  } catch (cause) {
    throw websocketError(
      "APP_SERVER_WEBSOCKET_CONNECT_FAILED",
      "The Codex app-server endpoint could not be reached.",
      cause,
    );
  }
  const key = randomBytes(16).toString("base64");
  const host = endpoint.type === "unix"
    ? "localhost"
    : `127.0.0.1:${new URL(endpoint.url).port}`;
  socket.write([
    "GET /rpc HTTP/1.1",
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...(token === null ? [] : [`Authorization: Bearer ${token}`]),
    "",
    "",
  ].join("\r\n"));

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(websocketError(
      "APP_SERVER_WEBSOCKET_HANDSHAKE_FAILED",
      "The Codex app-server WebSocket handshake timed out.",
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (cause) => fail(websocketError(
      "APP_SERVER_WEBSOCKET_HANDSHAKE_FAILED",
      "The Codex app-server WebSocket handshake failed.",
      cause,
    ));
    const onClose = () => fail(websocketError(
      "APP_SERVER_WEBSOCKET_HANDSHAKE_FAILED",
      "The Codex app-server closed during the WebSocket handshake.",
    ));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxHandshakeBytes) {
        fail(websocketError(
          "APP_SERVER_WEBSOCKET_HANDSHAKE_FAILED",
          "The Codex app-server WebSocket handshake exceeded its size limit.",
        ));
        return;
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = buffer.subarray(0, end).toString("utf8");
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      if (
        !/^HTTP\/1\.[01] 101(?: |$)/.test(header)
        || !header
          .split("\r\n")
          .some((line) => line.toLowerCase()
            === `sec-websocket-accept: ${accept}`.toLowerCase())
      ) {
        fail(websocketError(
          "APP_SERVER_WEBSOCKET_HANDSHAKE_REJECTED",
          "The Codex app-server rejected the WebSocket upgrade.",
        ));
        return;
      }
      cleanup();
      resolve({
        endpoint,
        socket,
        remainder: buffer.subarray(end + 4),
      });
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function probeCodexAppServerWebSocket(endpoint, options) {
  try {
    const { socket } = await openCodexAppServerWebSocket(endpoint, options);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}
