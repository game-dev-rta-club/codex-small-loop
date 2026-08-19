---
name: handling-user-requests
description: Use only when the user selects Codex Small Loop in Codex Desktop, explicitly invokes $codex-small-loop:handling-user-requests, or directly says "Use Codex Small Loop to ...". Shows the initial setup guide and resolves the execution profile before loading Controller.
---

# Handling User Requests

This is the user-facing Codex Small Loop entry point. Complete the welcome and
execution-profile exchange first. Load Controller on the next user-authored
turn only after the profile is resolved.

## Confirm Explicit Activation

Continue only when the active request:

- was started by selecting Codex Small Loop in Codex Desktop;
- explicitly invokes `$codex-small-loop:handling-user-requests`; or
- directly instructs Codex to use Codex Small Loop, for example, "Use Codex
  Small Loop to ...".

A mention, discussion, inspection, explanation, or question about Codex Small
Loop is ordinary request handling rather than activation.

## First Turn: Show Welcome And Ask For The Profile

On the first Codex Small Loop turn of every user-facing Root Task, show the
welcome guide before inspecting the project, external context, or requested
deliverable. Infer the first turn and any model or speed already supplied from
conversation history. Use no persistent preference or first-run state.

Resolve the plugin root. Read `contents/welcome/execution-profiles.json` and
`contents/welcome/initialization-guide.md` in full. Confirm that
`contents/welcome/welcome-loop.png` exists without loading its binary contents
into conversation context.

The Markdown guide is the complete English source. Copy its complete structure
into the final response and replace `{{WELCOME_IMAGE_ABSOLUTE_PATH}}` with the
welcome image's absolute filesystem path. Standard Markdown image syntax must
render the image directly in the conversation. Do not create HTML, a data URL,
a visualization file, or a duplicate guide.

The guide always contains the Slack and Obsidian recommendations. Inspect neither
the project nor connector state. If the latest user-authored message uses another
language, translate the visible text from English into that language.
Preserve the Markdown structure, links, model names, numeric benchmark values,
and absolute image path. Keep this first turn silent until the localized guide
and its Next Action are ready together in the final response.

Resolve the execution profile in this entry exchange:

- Speed defaults immediately to 1x whenever the user has not explicitly
  selected a speed. Do not ask a speed-only follow-up. Use 1.5x only when the
  user explicitly selects it.
- If the model is unknown, propose Terra Medium with the JSON default summary
  and ask only for the model decision. State that execution remains at 1x
  unless the user explicitly selects 1.5x.
- If the model is known, treat the profile as resolved using the explicit speed
  or the 1x default. Do not reconfirm either value; state the resolved profile
  briefly in the Next Action section.

For example, a reply containing only `Sol Medium` resolves to Sol Medium and
1x and proceeds to Controller. A reply containing only `1.5x` preserves that
speed but still asks for the model.

Reflect every resolved setting in the Markdown tables by bolding the selected
model and speed and removing bold from the previous default. A missing speed is
already resolved as 1x; only an unknown model remains unselected. Keep the
internal `serviceTier` value private.

An answer that supplies or changes a requested setting is agreement to that
value. Keep the resolved model and speed unchanged for the complete request.
The user-facing Controller Task keeps its Codex App execution settings. Retain
the selected model ID, reasoning effort, and speed as the resolved managed-Agent
profile so Controller can pass all three explicitly when it creates Primary.
Primary and its managed Children then inherit that resolved profile unless a
Child override is explicitly requested.

## Next Turn: Resolve The Profile And Load Controller

Do not load Controller in the same turn that first displays the welcome guide.
On the next user-authored turn, incorporate the user's profile answer. If the
model is still missing, ask only for the model and remain in this entry
exchange. Resolve an unspecified speed as 1x. Once the model and speed are
resolved:

1. Run `node <plugin-root>/components/commands/role.mjs controller`.
2. Read the command's complete output and apply only `controller` to this
   user-facing Root Task.
3. Continue immediately with Controller's first step in that same turn.

Controller owns project investigation, intent clarification, Interview, plan
agreement, Primary creation, supervision, verification, and delivery. This
entry Skill owns only explicit activation and initial setup. Primary remains a
separate managed Task created by Controller.

On a later explicit Codex Small Loop activation in the same user-facing Root
Task, skip the welcome and profile exchange. Run the Controller Role command
again, read its complete output, and continue under the latest Controller Role
in that same turn.

When another Codex Small Loop Job Role is explicit, follow that Role instead.
