---
keyPoints: >-
  Atomic Documentation gives each durable knowledge responsibility one
  canonical file and uses filenames plus substantive key points to make the
  repository understandable before full document bodies are opened.
---

# Atomic Documentation

Atomic Documentation is the write-side contract for fast project grounding.
`$codex-small-loop:understanding-works` first reads directories, filenames, and
key points to build a coarse model and decide which full documents matter.
Create the structure backward from that reading experience.

## Atomic Unit

An atomic document owns one independently nameable knowledge responsibility. It
is complete enough to understand on its own and focused enough that its filename
and key points distinguish it from nearby knowledge.

Split knowledge when the parts:

- have independent reasons to change;
- have different downstream consumers;
- answer independently nameable questions;
- need separate canonical links; or
- require materially different key points.

Keep knowledge together when the parts:

- cannot be understood independently;
- are always changed and consumed together;
- would receive nearly identical key points; or
- would become one- or two-sentence fragments with no useful identity.

Atomic means coherent ownership, not the smallest possible file and not a line
count threshold.

## Directory As Information Map

Use a directory to name the shared subject and its files to name the specific
owned knowledge. A reader should be able to predict where to look from the tree.

```text
work-graph/
├── concept.md
└── contract.md
```

Here, `work-graph` supplies the shared subject while `concept.md` and
`contract.md` identify distinct responsibilities. Prefer specific lowercase
kebab-case names. Generic names such as `misc`, `details`, and `notes` conceal
ownership unless the production practice gives them a precise established
meaning.

## Key Points Contract

Every atomic Markdown document uses YAML frontmatter with direct `keyPoints`:

```yaml
---
keyPoints: >-
  A Work Graph begins at one Overview, connects every downstream Work to its
  direct maintained inputs, and remains reachable and acyclic.
---
```

The key points state the current main specification, decisions, behavior, and
important boundaries in enough context to form a correct coarse model without
opening the body. Write the content itself and keep supporting detail in the
body. Keep the field current as the document changes.

Use native key-point metadata for other formats when it is natural and useful.
Each medium may keep its own appropriate representation instead of gaining a
sidecar solely to look like Markdown.

## Derived Navigation Instead Of Inventories

The current directory structure, filenames, and key points already form the
project map consumed by `$codex-small-loop:understanding-works`. A handwritten
README, index, or directory-named document that merely lists or summarizes
nearby files duplicates that map and can become stale after an add, move,
rename, or deletion.

Create an entry document only when serving a distinct audience is itself an
independent responsibility, such as a public repository README or a user-facing
landing page. Keep that entry stable and link to canonical detail instead of
copying changing inventories, graph relationships, or operating state.

## Canonical Ownership And Links

Store each durable claim in one canonical document. Other documents provide the
minimum context needed for their own responsibility and link to the owner using
a repository-root-relative Markdown path.

When two files describe the same rule, decide which one owns it. Move the full
meaning there, replace the duplicate with a link if readers still need the
relationship, and remove obsolete homes rather than leaving competing truths.

## Completion Check

A document set is ready when:

- directory names expose coherent knowledge areas;
- each filename identifies one owned responsibility;
- key points give a new agent the main current model and identify where details
  require a full read;
- no independent responsibility is hidden inside an unrelated long file;
- no useful context has been fragmented into meaningless pages;
- each durable claim has one canonical home;
- links reach related knowledge and maintained outputs; and
- derived navigation has not been duplicated by a handwritten inventory.
