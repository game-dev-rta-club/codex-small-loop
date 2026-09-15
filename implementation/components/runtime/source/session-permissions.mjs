import path from "node:path";

// Anonymous managed profiles emitted by Desktop describe effective permissions,
// not a named profile. Only project the standard sandbox when every entry is
// representable; never drop custom read/deny exceptions.
export function sessionSandboxPolicy(payload, type) {
  const source = payload.sandbox_policy;
  const managed = payload.permission_profile;
  if (managed.type !== "managed" || managed.id !== undefined) return { type };
  if (type !== "workspaceWrite" || managed.network !== "restricted"
      || source.network_access !== false || managed.file_system?.type !== "restricted") {
    throw new TypeError("Anonymous permission profile is not a supported workspace sandbox");
  }
  const roots = [...new Set([payload.cwd, ...(payload.workspace_roots ?? []), ...(source.writable_roots ?? [])])];
  if (roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) throw new TypeError("Invalid workspace roots");
  const expected = new Set(["special:root:read", ...roots.map((root) => `path:${root}:write`)]);
  if (!source.exclude_slash_tmp) expected.add("special:slash_tmp:write");
  if (!source.exclude_tmpdir_env_var) expected.add("special:tmpdir:write");
  const protectedPaths = new Set(roots.flatMap((root) => [".git", ".agents", ".codex"].map((name) => path.join(root, name))));
  const entries = managed.file_system.entries;
  if (!Array.isArray(entries)) throw new TypeError("Missing filesystem permission entries");
  const seen = new Set();
  for (const entry of entries) {
    const location = entry.path;
    if (location?.type === "path" && protectedPaths.has(location.path) && entry.access === "read"
        && (entry.missing_path_behavior === undefined || entry.missing_path_behavior === "skip")) continue;
    const key = location?.type === "path" ? `path:${location.path}:${entry.access}`
      : location?.type === "special" ? `special:${location.value?.kind}:${entry.access}` : null;
    if (!expected.has(key) || Object.keys(entry).some((k) => !["path", "access"].includes(k))) {
      throw new TypeError("Custom filesystem permission cannot be represented by the workspace sandbox");
    }
    seen.add(key);
  }
  if ([...expected].some((key) => !seen.has(key))) throw new TypeError("Workspace permission entries are incomplete");
  return { type, writableRoots: roots.filter((root) => root !== payload.cwd), networkAccess: false,
    excludeSlashTmp: source.exclude_slash_tmp ?? false, excludeTmpdirEnvVar: source.exclude_tmpdir_env_var ?? false };
}
