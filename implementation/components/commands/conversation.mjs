#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { runConversationCli } from "../runtime/source/communication-cli.mjs";

export { runConversationCli };

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runConversationCli(process.argv.slice(2));
}
