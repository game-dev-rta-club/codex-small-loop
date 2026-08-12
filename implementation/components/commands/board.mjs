#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  boardHostStatus,
  boardHostUrl,
  ensureBoardHost,
  stopBoardHost,
} from "../board/source/board-host.mjs";

function parse(argv) {
  const operation = argv.shift();
  if (!["ensure", "status", "url", "stop"].includes(operation)) throw new Error("Expected ensure, status, url, or stop");
  let projectRoot = process.cwd();
  while (argv.length) {
    const flag = argv.shift();
    if (flag !== "--project-root" || argv.length === 0) throw new Error(`Unsupported argument: ${flag}`);
    projectRoot = argv.shift();
  }
  return { operation, projectRoot: path.resolve(projectRoot) };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const { operation, projectRoot } = parse(process.argv.slice(2));
    const result = operation === "ensure" ? await ensureBoardHost(projectRoot)
      : operation === "status" ? await boardHostStatus(projectRoot)
      : operation === "url" ? await boardHostUrl(projectRoot)
      : await stopBoardHost(projectRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.run !== "ok") process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ run: "failed", code: error?.code ?? "BOARD_HOST_FAILED",
      message: "Board Host operation failed safely." })}\n`);
    process.exitCode = 1;
  }
}
