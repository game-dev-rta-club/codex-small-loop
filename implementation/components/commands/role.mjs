#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRole,
  RoleLoadError,
} from "../runtime/source/role-loader.mjs";

const DEFAULT_ROLES_ROOT = fileURLToPath(new URL("../roles/", import.meta.url));

function usageError(message) {
  return new RoleLoadError("ROLE_CLI_USAGE", message);
}

function parseArgs(argv) {
  if (
    !Array.isArray(argv)
    || argv.some((argument) => typeof argument !== "string")
    || argv.length !== 1
    || argv[0].length === 0
  ) {
    throw usageError("role requires exactly one <role> name.");
  }
  return argv[0];
}

export async function runRoleCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const role = parseArgs(argv);
    const contents = await loadRole(role, {
      rolesRoot: options.rolesRoot ?? DEFAULT_ROLES_ROOT,
    });
    stdout.write(contents);
    return 0;
  } catch (error) {
    const result = {
      run: "failed",
      code: error?.code ?? "ROLE_LOAD_FAILED",
      message: error instanceof RoleLoadError
        ? error.message
        : "Role loading failed safely.",
    };
    stderr.write(`${JSON.stringify(result)}\n`);
    return 1;
  }
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  process.exitCode = await runRoleCli(process.argv.slice(2));
}
