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
- Treat the ordinary model selection and the user-facing "thinking model" as
  the Primary model. If it is unknown,
  propose Terra Medium with the JSON default summary and ask only for the model
  decision, meaning the Primary model. State that execution remains at 1x unless the user explicitly
  selects 1.5x.
- Treat the user-facing "implementation model" as the optional Worker model;
  it applies to Execute, Review, and Interviewer.
  Do not add it to the normal question sequence or ask the user to choose one.
  Resolve it only when the user voluntarily supplies a separate implementation
  model. If the user explicitly asks to split thinking and implementation without
  naming the Worker model, ask only for that missing Worker model. Otherwise,
  resolve Worker to the Primary model without a follow-up.
- If the Primary model is known, treat the profiles as resolved using the
  explicit speed or the 1x default and the explicit Worker model or Primary
  fallback. Do not reconfirm any resolved value; state the resolved settings
  briefly in the Next Action section.

For example, a reply containing only `Sol Medium` resolves to Sol Medium and
1x and proceeds to Controller. A reply containing only `1.5x` preserves that
speed but still asks for the Primary model. A reply such as `Primary: Sol
Medium; implementation: Luna Max` resolves the separate Worker
model without adding another setup turn. If only the Worker model is supplied,
retain it while asking for the missing Primary model.

Reflect the resolved Primary model and speed in the Markdown tables by bolding
their selected rows and removing bold from the previous defaults. The optional
Worker model does not create another table or change the table selection; when
explicitly supplied, state it briefly after the speed table. A missing speed is
already resolved as 1x; only an unknown Primary model or an explicitly
requested but unnamed Worker model remains unresolved. Keep raw model IDs and
the internal `serviceTier` value private.

An answer that supplies or changes a requested setting is agreement to that
value. Keep the resolved profiles and speed unchanged for the complete request.
The user-facing Controller Task keeps its Codex App execution settings. Retain
the selected Primary model ID and reasoning effort as the Primary profile.
Retain the optional Worker model ID and reasoning effort as the Worker profile,
falling back to the Primary pair when it was omitted. Speed is shared by both.
Controller handles the user-facing thinking/implementation terminology and
passes the corresponding internal Primary/Worker profiles onward.
Controller passes the Primary model, reasoning effort, and speed explicitly
when it creates Primary and includes the resolved Worker model, reasoning
effort, and shared speed in Primary's assignment. Primary explicitly applies
that Worker profile whenever it creates an Execute, Review, or Interviewer.

## Next Turn: Resolve The Profile And Load Controller

Do not load Controller in the same turn that first displays the welcome guide.
On the next user-authored turn, incorporate the user's profile answer. If the
Primary model is still missing, ask only for that model and remain in this entry
exchange. If the user explicitly requested separate models but left the Worker
model missing, ask only for that value. Resolve an unspecified speed as 1x and
an unspecified Worker model to the Primary model. Once both profiles and speed
are resolved:

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
