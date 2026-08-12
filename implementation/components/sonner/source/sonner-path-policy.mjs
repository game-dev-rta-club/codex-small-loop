const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git", ".codex-small-loop", ".cache", ".next", ".parcel-cache",
  ".pytest_cache", ".turbo", "__pycache__", "build", "cache",
  "coverage", "dist", "node_modules", "out", "target",
]);

export function isExcludedSonnerProjectPath(projectPath) {
  return projectPath.split("/").some((part) => EXCLUDED_DIRECTORY_NAMES.has(part));
}
