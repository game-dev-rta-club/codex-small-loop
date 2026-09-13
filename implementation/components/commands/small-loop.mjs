#!/usr/bin/env node

// This dispatcher is shared by the npm package and the Codex plugin.
import { runSonnerCli, SONNER_CLI_USAGE } from "../sonner/source/sonner.mjs";

const [command, ...args] = process.argv.slice(2);
if ([undefined, "--help", "-h"].includes(command)) {
  process.stdout.write(`Usage: small-loop <command> [options]\n\n${SONNER_CLI_USAGE}\n\nSonner reads the current project without a Codex installation.\nUse --runtime to also inspect local Codex task records.\n`);
} else if (command === "sonner") {
  await runSonnerCli(args, { projectRoot: process.cwd(), includeRuntime: false });
} else {
  process.stderr.write("Unknown command. Usage: small-loop sonner [options]\n");
  process.exitCode = 1;
}
