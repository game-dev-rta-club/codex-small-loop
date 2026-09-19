---
keyPoints: >-
  Configure Sonner's project scope and implement project-owned metadata extractors
  with an explicit execution flag and a bounded versioned API.
---

# Sonner project extensions and queries

Sonner reads an optional, Git-visible `.sonner.json` at the project root.
The configuration is versioned separately from Sonner's output schema.
It is read through the same verified reader as project files. Invalid JSON,
unknown keys, and invalid paths fail the invocation; they do not silently
fall back to another scope.

```json
{
  "version": 1,
  "include": ["."],
  "exclude": ["Assets/ThirdParty"],
  "extensions": [
    {"suffix": ".meta", "module": ".agents/sonner/unity-metadata.mjs"},
    {"suffix": ".cs", "module": ".agents/sonner/unity-metadata.mjs"}
  ]
}
```

`include` defaults to `["."]`; `exclude` and `extensions` default to `[]`.
Paths are project-relative file or directory prefixes, not glob expressions.
A directory prefix matches that directory and its descendants, never a
similarly named sibling. Exclusions take precedence. These settings narrow
Git's admitted paths and cannot reintroduce Git-ignored content. A narrowed
scope produces a partial Work Graph rather than claiming full graph validation.
The configuration file itself is read even when outside the requested scope.

## Excluding project files and directories

Add project-relative paths to `exclude` in the root `.sonner.json` and commit
that configuration so the team shares the same exclusions. For example:

```json
{
  "version": 1,
  "exclude": ["Docs/参照禁止", "Docs/private-notes.md"]
}
```

Keep any existing `extensions` and `include` settings in the same object.
A directory entry excludes all descendants; a file entry excludes just that
file. Japanese names are supported. Paths are literal prefixes, not glob
patterns: `Docs/参照禁止ではない` is not excluded by `Docs/参照禁止`.

Exclusion applies before file-content reads, Work marker parsing, and extension
input collection. Excluded files do not contribute to Files entries or counts,
even when tracked by Git. `--path` and `--metadata-only` cannot override an
exclusion. Selecting an excluded directory returns an empty scoped result.
The selected root and exclusion settings may still appear as scope metadata;
Git may enumerate filenames to determine the admitted set. The root configuration
must remain readable so Sonner can apply it.

This controls Sonner's project reader, not other tools or project code that
performs its own IO. Record any broader agent reference prohibition in the
project's `AGENTS.md` as well.

## Project-owned extraction

Small Loop does not implement Unity `.meta` parsing or C# documentation parsing.
The project supplies its own ESM module and may import its own utility modules:

```js
import { readProjectMetadata } from './metadata-utils.mjs';

export const apiVersion = 1;

export async function extract({ path, text }) {
  return readProjectMetadata(path, text);
  // Return {}, or named string fields such as { description: "...", assetRole: "..." }.
}
```

Enable execution explicitly:

```sh
small-loop sonner --extensions --timeout-ms 30000
```

Without `--extensions`, configuration still narrows the scope but no project
module runs. Only enable extensions for a project whose code you trust. The
separate Node process provides timeout and output isolation, not an OS security
sandbox; project code executes with the caller's OS permissions. Modules should
be pure readers of their supplied input and should not modify files or contact
external services. Environment credentials are not forwarded to the worker.

For each admitted file matching a configured suffix, the extractor receives
its full project-relative `path` and UTF-8 `text` from at most the first 64 KiB.
Non-UTF-8 input is skipped. Suffix matching is case-insensitive; the longest
matching suffix wins, and duplicate suffixes are rejected. Modules are imported
once per invocation and files are processed in deterministic path order. Relative
imports work normally. No module executes when no selected file matches it.

Results may contain project-defined field names, including `keyPoints`, `summary`,
`description`, or `assetRole`. Each value must be a string of at most 8192 UTF-16
code units, null, or absent. Values are trimmed; empty strings are omitted.
Names must be non-blank and at most 8192 UTF-16 code units. The structural names
`path`, `name`, `type`, `text`, `children`, `counts`, `truncated`, `code`, and
`renameTo`, and the prototype-sensitive names `__proto__`, `prototype`, and
`constructor` are reserved and rejected, even with null values. Arrays, objects,
numbers, and booleans are not metadata values. API version remains 1. Async
extractors are supported. A throw, invalid result, failed import, excessive
output, or operation timeout fails the invocation without retrying another
version. The content-reader output budget is 16 MiB normally and 64 MiB with extensions.
The worker has a 128 MiB V8 heap limit; its input and output are bounded.
Use `console.error` for diagnostics; `console.log` is redirected to stderr.
On failure, up to 4096 characters of captured diagnostics accompany the error.
Do not write directly to stdout because it carries the result protocol.

In the default view, a file with any non-empty metadata field is listed individually and is not also
included in the extension counts. Other files retain the existing count format:

```text
Combat/ [WORK_NODE: combat] 2 meta, 3 cs
  Player.cs summary="Player: Controls movement and hook actions."
  Player.cs.meta keyPoints="Player asset import settings."
  ジャンプ台.prefab.meta description="プレイヤーを上に弾き飛ばすジャンプ台。"
```

Text renders each field as `fieldName="value"`; names other than ASCII identifiers
are quoted and escaped just like values. Fields are ordered as `keyPoints`,
`summary`, `description`, then other names in deterministic lexical order.
JSON preserves original field names, without renaming them.

The extractor defines its own metadata convention. For example, a Unity project
can choose a top-level `keyPoints` in its `.meta` files, and can choose type-level
XML documentation for `.cs` summaries. Sonner does not write or migrate those
files. Parsing incomplete prefixes and language-specific syntax belongs to the
project's extractor, which should return no metadata when uncertain.

## Query options

```sh
small-loop sonner --no-key-points
small-loop sonner --extensions --metadata-only
small-loop sonner --depth 2
small-loop sonner --path Assets/Gameplay
small-loop sonner --extensions --path Assets/Gameplay --depth 1 --no-key-points --json
```

- `--metadata-only` shows only Files entries with any non-empty metadata field, retaining the directories needed to reach them. Extension counts summarize
  those same matching files directly inside each directory (a file with multiple
  fields counts once). These counts include the individually listed files,
  unlike the default view's counts of unannotated files. Legacy warnings and
  directories without matching descendants are omitted;
  the selected root remains. JSON marks this mode with `metadataOnly: true`;
  text includes a Files filter note. This filters output, not disk reads, and leaves
  Work Graph and Runtime unchanged. Selection happens before `--no-key-points`
  hides values and before `--depth` trims the tree. Use `--extensions` as well
  to include metadata supplied by project modules. Applies to text and JSON.
- `--no-key-points` omits `keyPoints` from both Work and file output, including
  JSON. Individual filenames, counts, and all other metadata fields
  remain. This is an output option, not a request to skip metadata reads.
- `--depth N` limits directory expansion in Files. The selected root has depth
  0; files/counts directly within a visible directory remain visible. At the
  boundary, omitted child directories are indicated by `truncated: true` in
  JSON and an omission line in text. Counts remain direct-directory counts,
  not totals of hidden descendants. Work Graph is not depth-filtered. Supported
  values are 0–128; this is a display limit, not a disk-read limit.
- `--path DIR` reads Files and Work markers only from that project-relative
  directory and below. Git may enumerate the repository to apply ignore rules,
  and `.sonner.json` is read to determine configuration, but content outside
  the selected scope is not read by Sonner. A scope with no admitted files
  yields an empty result. Project code explicitly enabled with `--extensions`
  can perform its own IO and is responsible for respecting this convention.

`--path` combines with configuration `include`/`exclude` by intersection.
`--project-root` continues to identify the original repository root; paths in
JSON and extractor inputs remain relative to that root, even for a subtree.
Runtime remains a separate, project-wide observation when `--runtime` is used.

## Output schema 13

The default document retains `version`, `workGraph`, `files`, and optional
`runtime`. Metadata-bearing files carry project-defined fields directly on the file object. Hiding key
points removes that property rather than replacing it with an empty string.
A depth-limited result adds `maxDepth` and marks truncated directories.
A narrowed scope adds `selection` with `path`, `include`, `exclude`, and `partial`.

A scoped Work Graph has status `partial` and lists only the parsed local Works
in ID order. Work IDs and metadata are checked locally; cross-scope references,
Overview reachability, and full-graph cycles are not validated. Inputs can name
Works outside the result; outputs include only relationships observed inside it.
Unsafe or malformed local markers still produce `invalid`. Work directory
labels appear for both valid full graphs and partial graphs. The Board's default
view does not execute project extensions and identifies partial graph state
without trying to lay out unresolved cross-scope edges.
