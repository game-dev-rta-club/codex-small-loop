import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeLineEndings } from "./text-line-endings.mjs";

const MAX_ROLE_NAME_LENGTH = 128;

export class RoleLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoleLoadError";
    this.code = code;
  }
}

export function validRoleName(role) {
  return typeof role === "string"
    && role.length <= MAX_ROLE_NAME_LENGTH
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(role);
}

export async function loadRole(role, options = {}) {
  if (!validRoleName(role)) {
    throw new RoleLoadError(
      "ROLE_NAME_INVALID",
      "Role must be a bounded kebab-case name.",
    );
  }

  const rolesRoot = path.resolve(options.rolesRoot);
  const roleFile = path.join(rolesRoot, role, "role.md");
  try {
    return normalizeLineEndings(await readFile(roleFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new RoleLoadError(
        "ROLE_NOT_FOUND",
        `Installed Role not found: ${role}`,
      );
    }
    throw error;
  }
}
