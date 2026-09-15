---
keyPoints: >-
  Refresh the configured marketplace, reinstall Codex Small Loop, and verify the
  immutable installed plugin snapshot before starting new work.
---

# Update Codex Small Loop

Source changes do not update an installed plugin cache or a running process.
Wait until no active Codex Small Loop work depends on the installed snapshot,
then refresh its Git marketplace:

```sh
codex plugin marketplace upgrade codex-small-loop --json
```

For a marketplace registered from a local checkout, update that checkout
instead. Reinstall through the supported plugin commands; never edit the cache
directly:

```sh
set -euo pipefail
codex plugin remove codex-small-loop@codex-small-loop --json
INSTALL_RESULT="$(codex plugin add codex-small-loop@codex-small-loop --json)"
CSL_PLUGIN_ROOT="$(
  node -e '
    const result = JSON.parse(process.argv[1]);
    if (typeof result.installedPath !== "string" || !result.installedPath) {
      throw new Error("codex plugin add did not return installedPath");
    }
    process.stdout.write(result.installedPath);
  ' "$INSTALL_RESULT"
)"
export CSL_PLUGIN_ROOT
```

The returned `installedPath` is the source of truth for the immutable snapshot.
Verify the plugin is enabled and the expected entrypoint exists:

```sh
codex plugin list --json | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const plugins = JSON.parse(input).installed;
    const plugin = plugins.find(
      (item) => item.pluginId === "codex-small-loop@codex-small-loop",
    );
    if (!plugin?.installed || !plugin?.enabled) {
      throw new Error("Codex Small Loop is not installed and enabled");
    }
  });
'

test -f "$CSL_PLUGIN_ROOT/.codex-plugin/plugin.json"
test -f "$CSL_PLUGIN_ROOT/assets/codex-small-loop.svg"
test -f "$CSL_PLUGIN_ROOT/contents/welcome/initialization-guide.md"
test -f "$CSL_PLUGIN_ROOT/contents/welcome/execution-profiles.json"
test -f "$CSL_PLUGIN_ROOT/contents/welcome/welcome-loop.png"
test -f "$CSL_PLUGIN_ROOT/skills/handling-user-requests/SKILL.md"
grep -Fq 'components/commands/role.mjs controller' \
  "$CSL_PLUGIN_ROOT/skills/handling-user-requests/SKILL.md"
```

On Windows PowerShell, use the same plugin operations without POSIX shell
substitution:

```powershell
codex plugin remove codex-small-loop@codex-small-loop --json
$installResult = codex plugin add codex-small-loop@codex-small-loop --json |
  Out-String | ConvertFrom-Json
$CSL_PLUGIN_ROOT = $installResult.installedPath
if (-not [System.IO.Path]::IsPathFullyQualified($CSL_PLUGIN_ROOT)) {
  throw "codex plugin add did not return an absolute installedPath"
}

$plugin = (codex plugin list --json | Out-String | ConvertFrom-Json).installed |
  Where-Object pluginId -eq 'codex-small-loop@codex-small-loop'
if (-not $plugin.installed -or -not $plugin.enabled) {
  throw "Codex Small Loop is not installed and enabled"
}

@(
  '.codex-plugin/plugin.json',
  'assets/codex-small-loop.svg',
  'contents/welcome/initialization-guide.md',
  'contents/welcome/execution-profiles.json',
  'contents/welcome/welcome-loop.png',
  'skills/handling-user-requests/SKILL.md'
) | ForEach-Object {
  if (-not (Test-Path -LiteralPath (Join-Path $CSL_PLUGIN_ROOT $_) -PathType Leaf)) {
    throw "Installed plugin file is missing: $_"
  }
}

$entrySkill = Get-Content -Raw -LiteralPath (
  Join-Path $CSL_PLUGIN_ROOT 'skills/handling-user-requests/SKILL.md'
)
if (-not $entrySkill.Contains('components/commands/role.mjs controller')) {
  throw "Installed entry Skill does not load Controller"
}
```

Open a new Codex conversation and confirm that **Codex Small Loop** appears in
the Desktop **+** menu before relying on the update.

## Reference

- [Installation](/user-documentation/install.md)
- [Plugin Distribution](/specification/technical-specification/package/plugin-distribution.md)
