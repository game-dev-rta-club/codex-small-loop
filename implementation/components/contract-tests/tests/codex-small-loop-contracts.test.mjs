import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);

async function read(relativePath) {
  return (await readFile(path.join(repositoryRoot, relativePath), "utf8"))
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

async function exists(relativePath) {
  try {
    await access(path.join(repositoryRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

const findingSignalPathContractPattern =
  /(?:(?:each|every|a)\s+`?FINDING`?(?:\s+entry)?\s+(?:must\s+)?(?:give|provide|include)s?|for\s+(?:each|every|a)\s+`?FINDING`?(?:\s+entry)?\s*,?\s*(?:give|provide|include)s?)(?:(?!\r?\n[ \t]*\r?\n)[^.]){0,80}(?:Review\s+)?signal\s+(?:file\s+)?path/i;
const forbiddenPathOnlyHandoffPattern =
  /(?:(?:do|does)\s+not\s+repeat(?:(?!\r?\n[ \t]*\r?\n)[^.]){0,100}(?:finding(?:'s)?\s+details?|details?\s*,\s*evidence\s*,\s*(?:or\s+)?proposed correction)|(?:finding(?:'s)?\s+details?|details?\s*,\s*evidence\s*,\s*(?:or\s+)?proposed correction)(?:(?!\r?\n[ \t]*\r?\n)[^.]){0,100}(?:do|does)\s+not\s+repeat)/i;

async function listMarkdown(relativeDirectory) {
  const directory = path.join(repositoryRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const documents = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      documents.push(...await listMarkdown(relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      documents.push(relativePath);
    }
  }

  return documents;
}

async function listRepositoryFiles(relativeDirectory = "") {
  const directory = path.join(repositoryRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  const excludedRoots = new Set([
    ".git",
    ".obsidian",
    ".codex-small-loop",
  ]);

  for (const entry of entries) {
    if (!relativeDirectory && excludedRoots.has(entry.name)) {
      continue;
    }

    if (entry.name === ".DS_Store") {
      continue;
    }

    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listRepositoryFiles(relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

test("one shared document owns Review Signal evaluation", async () => {
  const evaluation = await read(
    "implementation/contents/review/signal-evaluation.md",
  );

  assert.match(evaluation, /^---\nsummary:/);
  assert.match(evaluation, /Development Efficiency/i);
  assert.match(evaluation, /User Experience/i);
  assert.match(evaluation, /environment[\s\S]*documentation[\s\S]*rules/i);
  assert.match(evaluation, /long-term[\s\S]*code/i);
  assert.match(evaluation, /usability/i);
  assert.match(evaluation, /defect|bug/i);

  for (const severity of ["required", "consider", "later", "dismiss"]) {
    assert.match(evaluation, new RegExp(`\\b${severity}\\b`, "i"));
  }

  assert.match(evaluation, /responsibility[\s\S]*where to inspect/i);
  assert.match(evaluation, /evaluation standard[\s\S]*severity/i);
  assert.match(evaluation, /not[\s\S]*find[\s\S]*`required`/i);
  assert.match(
    evaluation,
    /Reporting no\s+`required` Signal has substantial value/i,
  );
  assert.match(evaluation, /Explanation[\s\S]*support[\s\S]*`required`/i);
  assert.match(evaluation, /later Review pass[\s\S]*new `required`/i);
  assert.match(evaluation, /Primary[\s\S]*raise\s+or\s+lower[\s\S]*severity/i);
  assert.match(evaluation, /only[\s\S]*`required`[\s\S]*Interview[\s\S]*Execute/i);
  assert.match(evaluation, /not[\s\S]*carry[\s\S]*future Milestone/i);
});

test("current delivery documentation uses the severity-only required correction flow", async () => {
  const overview = await read("overview/overview.md");
  const verifiedDelivery = await read("product-concept/verified-delivery.md");
  const continuousLoop = await read("product-concept/continuous-delivery-loop.md");
  const managedLoop = await read(
    "specification/system-specification/coordination/managed-delivery-loop.md",
  );
  const boardInteraction = await read(
    "specification/interaction-specification/delivery/local-board.md",
  );
  const conversations = await read(
    "specification/technical-specification/runtime/conversations.md",
  );
  const signalContract = await read(
    "specification/technical-specification/runtime/review-snapshots-and-signals.md",
  );
  const execute = await read("implementation/components/roles/execute/role.md");

  for (const source of [overview, verifiedDelivery, continuousLoop, managedLoop]) {
    assert.match(source, /required/i);
    assert.doesNotMatch(
      source,
      /disposition|adopted? (?:Signal|finding|correction)|high-severity/i,
    );
  }

  for (const source of [overview, verifiedDelivery, signalContract]) {
    assert.match(source, /Baseline Verification/i);
    assert.match(source, /Trust Review|Trust checks/i);
    assert.match(
      source,
      /Technical Excellence\s+Review|Technical Excellence checks/i,
    );
    assert.match(source, /Customer Value\s+Review|Customer Value checks/i);
    assert.doesNotMatch(
      source,
      /Outcome, Integrity|Outcome checks|Integrity checks|Operability checks/i,
    );
  }

  assert.match(managedLoop, /signal-evaluation\.md/);
  assert.match(managedLoop, /Primary[\s\S]*final severity/is);
  assert.match(managedLoop, /only[\s\S]*required[\s\S]*Interviewer/is);
  assert.match(boardInteraction, /Compact severity\s+marker/i);
  assert.doesNotMatch(boardInteraction, /severity and disposition markers/i);
  assert.match(conversations, /clarify the required Signal/i);
  assert.match(execute, /supplied required Signal/i);
  assert.doesNotMatch(execute, /supplied adopted Signal/i);
  assert.doesNotMatch(signalContract, /--replace.*decision|decision.*--replace/is);
  assert.match(signalContract, /^## Explanation/m);
  assert.match(signalContract, /^## Implementation Approach/m);
});

test("handling-user-requests renders setup before loading Controller", async () => {
  const plugin = JSON.parse(await read("implementation/.codex-plugin/plugin.json"));
  const prompts = Array.isArray(plugin.interface.defaultPrompt)
    ? plugin.interface.defaultPrompt
    : [plugin.interface.defaultPrompt];
  const skill = await read("implementation/skills/handling-user-requests/SKILL.md");
  const frontmatter = skill.split("---", 3)[1];
  const welcomeIndex = skill.indexOf("initialization-guide.md");
  const roleIndex = skill.indexOf("components/commands/role.mjs controller");
  const welcome = await read("implementation/contents/welcome/initialization-guide.md");

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /components\/commands\/role\.mjs|SKILL\.md/i);
  assert.match(skill, /name:\s*handling-user-requests/);
  assert.match(frontmatter, /description:\s*Use (?:only )?when/i);
  assert.match(frontmatter, /selects Codex Small Loop|Use Codex Small Loop to/i);
  assert.match(skill, /Confirm Explicit Activation/);
  assert.match(skill, /contents\/welcome\/execution-profiles\.json/);
  assert.match(skill, /contents\/welcome\/initialization-guide\.md/);
  assert.match(skill, /contents\/welcome\/welcome-loop\.png/);
  assert.ok(welcomeIndex >= 0 && roleIndex > welcomeIndex);
  assert.match(skill.slice(welcomeIndex, roleIndex), /final response/i);
  assert.match(skill.slice(welcomeIndex, roleIndex), /next user-authored turn/i);
  assert.doesNotMatch(skill, /visualize:visualize|::codex-inline-vis/);
  assert.match(skill, /read.*complete output/is);
  assert.match(skill, /later explicit Codex Small Loop activation/i);
  assert.match(skill, /Controller Role command\s+again/i);
  assert.match(skill, /project.*investigation.*Controller|Controller.*project.*investigation/is);
  const modelTableIndex = welcome.indexOf("| Model |");
  const splitModelNoteIndex = welcome.indexOf("separate models for thinking and implementation");
  const speedTableIndex = welcome.indexOf("| Speed |");
  assert.ok(modelTableIndex >= 0 && modelTableIndex < splitModelNoteIndex && splitModelNoteIndex < speedTableIndex);
  assert.match(skill, /user-facing "thinking model" as\s+the Primary model/i);
  assert.match(skill, /user-facing "implementation model" as the optional Worker model/i);
  assert.match(skill, /Execute, Review, and Interviewer/i);
  assert.match(skill, /Do not add it to the normal question sequence/i);
  assert.match(skill, /resolve Worker to the Primary model without a follow-up/i);
});

test("Primary judgment and delegated detail work use resolved separate profiles", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");
  const primary = await read("implementation/components/roles/primary/role.md");
  const activation = await read(
    "specification/interaction-specification/activation/activation-and-execution-profile.md",
  );

  assert.match(controller, /selected model and reasoning effort exactly as the Primary\s*profile/is);
  assert.match(controller, /thinking model is Primary.*implementation\s*model is Worker/is);
  assert.match(controller, /Worker model.*reasoning effort.*service tier/is);
  assert.match(controller, /Worker defaults? to the Primary/is);
  assert.match(activation, /Primary model, reasoning\s*effort, and speed/is);
  assert.match(activation, /Worker model, reasoning effort, and shared speed/is);
  assert.match(activation, /Worker pair equals the Primary pair/is);
  assert.match(controller, /Execute, Review,\s*and Interviewer.*Worker profile/is);
  assert.match(primary, /Primary owns Milestone judgment/i);
  assert.match(primary, /Worker model, reasoning\s*effort, and service tier explicitly/is);
  assert.match(primary, /Execute, Review, or\s*Interviewer Task/is);
  assert.match(primary, /Do not rely on source-profile inheritance/i);
  assert.match(primary, /profile mismatch or missing\s*Worker profile is a fail-closed/i);
});

test("controller mediates every user-facing exchange without implementing", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");

  assert.match(controller, /^---\nsummary:/);
  assert.match(controller, /Controller Job Role/i);
  assert.match(controller, /user intent/i);
  assert.match(controller, /interview/i);
  assert.match(controller, /\$codex-small-loop:interview-me/);
  assert.match(controller, /conversation history/i);
  assert.match(controller, /clearly agreed/i);
  assert.match(controller, /meaning, not a required phrase/i);
  assert.match(controller, /every discoverable material ambiguity/i);
  assert.match(controller, /primary/i);
  assert.match(controller, /progress/i);
  assert.match(controller, /delivery/i);
  assert.match(controller, /one fresh Primary for each Milestone/i);
  assert.match(controller, /working-with-codex-tasks[\s\S]*`primary` fork/i);
  assert.match(controller, /does not modify project files|must not modify project files/i);
  assert.match(controller, /one[- ]minute/i);
  assert.match(controller, /ten[- ]minute/i);
  assert.match(controller, /schedule apply\/read\/delete/i);
  assert.match(controller, /never use Codex App\s+`automation_update`/i);
  assert.match(controller, /etag/i);
  assert.match(controller, /thread heartbeat/i);
  assert.match(controller, /no fixed (?:elapsed-time )?limit/i);
  assert.match(controller, /same Controller.*fork a fresh[\s\S]*Primary/is);
  assert.match(controller, /must not.*Primary.*children|does not.*Primary.*children/is);
  assert.doesNotMatch(controller, /co-located.*primary/is);

  const primaryForkIndex = controller.indexOf("context-preserving `primary` fork");
  const startupHeartbeatIndex = controller.indexOf(
    "one-minute startup thread heartbeat",
  );
  const executeProofIndex = controller.indexOf("Once Execute startup is proven");
  const steadyHeartbeatIndex = controller.indexOf("ten-minute steady-state heartbeat");
  assert.ok(primaryForkIndex >= 0 && primaryForkIndex < startupHeartbeatIndex);
  assert.ok(executeProofIndex >= 0 && executeProofIndex < steadyHeartbeatIndex);
});

test("controller advances a large request through bounded milestone conversations", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");
  const primary = await read("implementation/components/roles/primary/role.md");
  const controllerSpec = await read("specification/system-specification/roles/controller.md");
  const primarySpec = await read("specification/system-specification/roles/primary.md");
  const coordinationTechnical = await read("specification/technical-specification/runtime/task-coordination.md");

  assert.match(controller, /Milestone/i);
  assert.match(controller, /lifestyle management app/i);
  assert.match(controller, /TODO management/i);
  assert.match(controller, /journal/i);
  assert.match(controller, /calendar/i);
  assert.match(controller, /too\s+small/i);
  assert.match(controller, /too\s+large/i);
  assert.match(controller, /rough.*Milestone.*outline/is);
  assert.match(controller, /current.*Milestone.*scope/is);
  assert.match(controller, /fresh Primary/i);
  assert.match(controller, /Never reuse a Primary/i);
  assert.match(controller, /reassess.*remaining.*Milestone/is);
  assert.match(controller, /without.*user approval/is);
  assert.match(controller, /notify the user.*completed.*continues next/is);
  assert.match(controller, /stop the completed Primary branch/i);

  assert.match(primary, /overall.*Milestone.*context/is);
  assert.match(primary, /current Milestone.*implementation scope/is);
  assert.match(primary, /later Milestones?.*out\s+of\s+scope/is);
  assert.match(primary, /Start every Milestone with one fresh `execute` fork/is);

  assert.match(controller, /unspecified.*requirements/i);
  assert.match(controller, /add.*remove.*work/is);
  assert.match(controller, /completion authority/i);
  assert.match(controller, /outside.*delegated authority/i);
  assert.doesNotMatch(controller, /Milestone (?:file|record|status|ID)/i);

  assert.match(controllerSpec, /Milestones are lightweight reasoning boundaries/i);
  assert.match(primarySpec, /current-Milestone acceptance/i);
  assert.match(primarySpec, /Controller owns independent.*complete request/is);
  assert.match(coordinationTechnical, /represented Root Tasks use `Controller`/i);
  assert.doesNotMatch(coordinationTechnical, /represented Root Tasks use `Primary`/i);
});

test("controller keeps Primary clarification live until execution becomes a Conversation", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");
  const primary = await read("implementation/components/roles/primary/role.md");
  const controllerSpec = await read("specification/system-specification/roles/controller.md");

  for (const source of [controller, controllerSpec]) {
    assert.match(source, /pre-execution.*interview/i);
    assert.match(source, /working-with-codex-tasks[\s\S]*one-way Notification/i);
    assert.match(source, /ordinary (?:local )?final\s+(?:answer|output|response)/i);
    assert.match(source, /task wait/i);
    assert.doesNotMatch(source, /read_thread|wait_threads/i);
    assert.match(source, /no.*reply obligation|reply obligation.*none/is);
    assert.match(source, /no.*heartbeat|without.*heartbeat/is);
    assert.match(source, /ready.*execution|execution.*ready/is);
    assert.match(source, /(?:first|current) Milestone[\s\S]*(?:managed )?Conversation[\s\S]*Role\s+reload/i);

    const liveInterview = source.search(/pre-execution.*interview/i);
    const startupHeartbeat = source.search(/one[- ]minute[\s\S]{0,80}heartbeat/i);
    const executionReady = source.search(
      /When execution is ready|After `READY_FOR_EXECUTION`/i,
    );
    assert.ok(liveInterview >= 0 && liveInterview < startupHeartbeat);
    assert.ok(executionReady >= 0 && liveInterview < executionReady);
    assert.ok(startupHeartbeat >= executionReady);
  }

  assert.match(primary, /pre-execution.*interview/i);
  assert.match(primary, /Notification[\s\S]*ordinary\s+(?:local\s+)?final\s+(?:answer|output|response)/i);
  assert.match(primary, /do not send a managed reply or Notification/i);
  assert.match(primary, /exact local Turn through Codex Small Loop/i);
  assert.match(primary, /do not.*Execute|must not.*Execute/is);
  assert.match(primary, /execution\s+Conversation/i);
});

test("controller heartbeat state machine drives two revisioned Milestones", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");
  const controllerSpec = await read("specification/system-specification/roles/controller.md");
  const deliveryLoop = await read(
    "specification/system-specification/coordination/managed-delivery-loop.md",
  );
  const lifecycle = await read(
    "specification/technical-specification/runtime/lifecycle-and-recovery.md",
  );

  const machineBlock = controller.match(
    /<!-- HEARTBEAT_STATE_MACHINE_BEGIN -->([\s\S]*?)<!-- HEARTBEAT_STATE_MACHINE_END -->/,
  )?.[1];
  assert.ok(machineBlock, "Controller Role must contain the normative state table");
  const machine = new Map();
  for (const line of machineBlock.split("\n")) {
    if (!/^\| `(?:LIVE|START_PENDING|START_BOUND|STEADY|ADVANCE_STOP|ADVANCE_DELETE|TERMINAL_DELETE)` \|/.test(line)) continue;
    const [stateCell, bindingCell, actionsCell, nextCell] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const state = stateCell.replaceAll("`", "");
    const actions = actionsCell.replaceAll("`", "").split(",");
    const next = [...nextCell.matchAll(/`([A-Z_]+)(?:\(G\+1\))?`/g)]
      .map((match) => match[1]);
    machine.set(state, {
      binding: bindingCell.replaceAll("`", ""),
      actions: new Set(actions),
      next: new Set(next),
    });
  }

  const deleteGateBlock = controller.match(
    /<!-- START_PENDING_DELETE_GATE_BEGIN -->([\s\S]*?)<!-- START_PENDING_DELETE_GATE_END -->/,
  )?.[1];
  assert.ok(deleteGateBlock, "Controller Role must contain the pending deletion gate");
  const deleteGate = new Map();
  for (const line of deleteGateBlock.split("\n")) {
    const match = line.match(/^\| `([A-Za-z]+)` \| `([^`]+)` \|$/);
    if (match) deleteGate.set(match[1], match[2]);
  }
  assert.deepEqual([...deleteGate.keys()], [
    "tupleMatch",
    "targetPrimary",
    "invocationsAfterReadback",
    "laterInvocation",
    "completedResult",
    "boundedResult",
    "attributableResult",
    "exitStatus",
    "operation",
    "run",
    "code",
    "message",
    "conversationId",
    "partialEvidence",
    "queuedEvidence",
    "deliveryEvidence",
    "committedEvidence",
    "matchingConversations",
  ]);

  const states = [
    "LIVE",
    "START_PENDING",
    "START_BOUND",
    "STEADY",
    "ADVANCE_STOP",
    "ADVANCE_DELETE",
    "TERMINAL_DELETE",
  ];
  assert.deepEqual([...machine.keys()], states);
  assert.deepEqual([...machine.get("START_PENDING").next], ["START_BOUND", "LIVE"]);
  assert.deepEqual([...machine.get("STEADY").next], ["ADVANCE_STOP", "TERMINAL_DELETE"]);
  assert.deepEqual([...machine.get("ADVANCE_DELETE").next], ["LIVE"]);
  assert.match(machine.get("START_PENDING").binding, /conversation=uncommitted/);
  assert.match(machine.get("START_BOUND").binding, /conversation=exact_CID/);

  const actionOwner = new Map();
  for (const [state, row] of machine) {
    for (const action of row.actions) {
      assert.equal(actionOwner.has(action), false, `${action} must be state-disjoint`);
      actionOwner.set(action, state);
    }
  }

  const sameTuple = (left, right) => left !== null && right !== null &&
    ["C", "P", "S", "G", "R", "state", "conversation"]
      .every((key) => left[key] === right[key]);
  const canAct = (current, delivered, action, evidence = {}) => {
    if (!sameTuple(current, delivered)) return false;
    if (["START_BOUND", "STEADY"].includes(current.state) &&
      evidence.conversationStatus === "accepted") return false;
    return machine.get(current.state)?.actions.has(action) === true;
  };
  const canDeletePending = (current, delivered, evidence) =>
    canAct(current, delivered, "delete_pending_noncommit") &&
    [...deleteGate].every(([field, required]) => String(evidence?.[field]) === required);
  const canRebindPending = (current, delivered, evidence) =>
    canAct(current, delivered, "rebind_exact_conversation") &&
    typeof evidence?.uniqueConversationId === "string" &&
    evidence.uniqueConversationId.length > 0 &&
    evidence.ambiguous !== true;
  const mayInvokeStart = (state, invocationCount) =>
    state === "START_PENDING" && invocationCount === 0;
  const transition = (current, nextState, changes = {}) => {
    assert.equal(machine.get(current.state).next.has(nextState), true);
    return {
      ...current,
      ...changes,
      R: current.R + 1,
      state: nextState,
    };
  };

  const pending1 = {
    C: "C", P: "P1", S: "S1", G: 1, R: 1,
    state: "START_PENDING", conversation: "uncommitted",
  };
  const live1 = { C: "C", P: "P1", S: null, G: 1, R: 0, state: "LIVE", conversation: null };
  const failedCreation = live1;
  assert.equal(machine.get(failedCreation.state).actions.has("start_execution_conversation"), false);
  assert.equal(canAct(pending1, pending1, "inspect_start_evidence"), true);
  assert.equal(canAct(pending1, pending1, "recover_bound_execution"), false);
  assert.equal(canAct(pending1, pending1, "stop_handoff_primary"), false);
  assert.equal(canAct(pending1, pending1, "bootstrap_primary"), false);
  assert.equal(canDeletePending(pending1, pending1, {}), false);
  assert.equal(canDeletePending(pending1, pending1, { matchingConversations: "0" }), false);

  const failedNoncommit = {
    tupleMatch: "true",
    targetPrimary: "exact_P",
    invocationsAfterReadback: "1",
    laterInvocation: "false",
    completedResult: "true",
    boundedResult: "true",
    attributableResult: "true",
    exitStatus: "1",
    operation: "start",
    run: "failed",
    code: "present",
    message: "present",
    conversationId: "absent",
    partialEvidence: "false",
    queuedEvidence: "false",
    deliveryEvidence: "false",
    committedEvidence: "false",
    matchingConversations: "0",
  };
  assert.equal(canDeletePending(pending1, pending1, failedNoncommit), true);
  const deletionMustFail = [
    {},
    { matchingConversations: "0" },
    { ...failedNoncommit, invocationsAfterReadback: "0" },
    { ...failedNoncommit, completedResult: "false" },
    { ...failedNoncommit, boundedResult: "false" },
    { ...failedNoncommit, attributableResult: "false" },
    { ...failedNoncommit, exitStatus: "2", run: "partial", partialEvidence: "true" },
    { ...failedNoncommit, exitStatus: "0", run: "ok" },
    { ...failedNoncommit, conversationId: "CID1" },
    { ...failedNoncommit, queuedEvidence: "true" },
    { ...failedNoncommit, deliveryEvidence: "true" },
    { ...failedNoncommit, committedEvidence: "true" },
    { ...failedNoncommit, laterInvocation: "true" },
    { ...failedNoncommit, targetPrimary: "wrong_P" },
    { ...failedNoncommit, operation: "continue" },
    { ...failedNoncommit, run: "partial" },
    { ...failedNoncommit, code: "absent" },
    { ...failedNoncommit, message: "absent" },
    { ...failedNoncommit, matchingConversations: "1" },
    { ...failedNoncommit, matchingConversations: "2" },
  ];
  for (const evidence of deletionMustFail) {
    assert.equal(canDeletePending(pending1, pending1, evidence), false);
  }
  assert.equal(canDeletePending(
    pending1,
    { ...pending1, R: pending1.R - 1 },
    failedNoncommit,
  ), false);
  assert.equal(canDeletePending(
    pending1,
    { ...pending1, G: pending1.G + 1 },
    failedNoncommit,
  ), false);

  assert.equal(mayInvokeStart("START_PENDING", 0), true);
  assert.equal(mayInvokeStart("START_PENDING", 1), false);
  assert.equal(mayInvokeStart("START_PENDING", 2), false);
  const noncommitLive1 = {
    ...live1,
    R: pending1.R + 1,
  };
  assert.equal(machine.get(pending1.state).next.has(noncommitLive1.state), true);
  assert.equal(noncommitLive1.S, null);
  const freshPendingAfterCleanup = { ...pending1, R: noncommitLive1.R + 1 };
  assert.equal(mayInvokeStart(freshPendingAfterCleanup.state, 0), true);

  assert.equal(canRebindPending(
    pending1,
    pending1,
    { uniqueConversationId: "CID1", resultRun: "ok" },
  ), true);
  assert.equal(canRebindPending(
    pending1,
    pending1,
    { uniqueConversationId: "CID1", resultRun: "partial" },
  ), true);
  assert.equal(canRebindPending(
    pending1,
    pending1,
    { uniqueConversationId: "CID1", source: "bounded-ledger" },
  ), true);
  assert.equal(canRebindPending(
    pending1,
    pending1,
    { uniqueConversationId: "CID1", ambiguous: true },
  ), false);
  assert.equal(canRebindPending(pending1, pending1, {}), false);

  // CID1 commits between turns. Pending may only rebind the same S; failed
  // rebind/read-back leaves the old tuple authoritative.
  const failedRebind = pending1;
  assert.equal(canAct(failedRebind, pending1, "recover_bound_execution"), false);
  const bound1 = transition(pending1, "START_BOUND", { conversation: "CID1" });
  assert.equal(bound1.S, pending1.S);
  assert.equal(canAct(bound1, pending1, "rebind_exact_conversation"), false);
  assert.equal(canAct(bound1, bound1, "recover_bound_execution"), true);
  const steady1 = transition(bound1, "STEADY");
  assert.equal(canAct(steady1, bound1, "supervise_steady_execution"), false);
  assert.equal(canAct(
    steady1,
    steady1,
    "supervise_steady_execution",
    { conversationStatus: "accepted" },
  ), false);

  // The handoff is armed before acceptance. Both interruption windows resume
  // solely from ADVANCE_STOP; old STEADY deliveries are inert.
  const advanceStop1 = transition(steady1, "ADVANCE_STOP");
  const failedAdvanceArm = steady1;
  assert.equal(canAct(failedAdvanceArm, steady1, "accept_handoff_conversation"), false);
  assert.equal(canAct(advanceStop1, steady1, "accept_handoff_conversation"), false);
  assert.equal(canAct(advanceStop1, advanceStop1, "accept_handoff_conversation"), true);
  assert.equal(canAct(advanceStop1, advanceStop1, "stop_handoff_primary"), true);
  const partialStopStillArmed = advanceStop1;
  assert.equal(canAct(partialStopStillArmed, advanceStop1, "recover_handoff_stop"), true);
  assert.equal(canAct(partialStopStillArmed, advanceStop1, "delete_advance_schedule"), false);
  const advanceDelete1 = transition(advanceStop1, "ADVANCE_DELETE");
  assert.equal(canAct(advanceDelete1, advanceStop1, "delete_advance_schedule"), false);
  assert.equal(canAct(advanceDelete1, advanceDelete1, "delete_advance_schedule"), true);
  assert.equal(canAct(advanceDelete1, advanceDelete1, "bootstrap_primary"), false);
  const failedDelete = advanceDelete1;
  assert.equal(canAct(failedDelete, advanceDelete1, "bootstrap_primary"), false);

  // Exact S1 absence is the only point at which G2 may enter LIVE and create a
  // new schedule. No G1 revision or generation can authorize a G2 action.
  const live2 = { C: "C", P: "P2", S: null, G: 2, R: 0, state: "LIVE", conversation: null };
  const pending2 = {
    C: "C", P: "P2", S: "S2", G: 2, R: 1,
    state: "START_PENDING", conversation: "uncommitted",
  };
  assert.equal(machine.get(live2.state).actions.has("bootstrap_primary"), true);
  for (const stale1 of [pending1, bound1, steady1, advanceStop1, advanceDelete1]) {
    assert.equal(canAct(pending2, stale1, "inspect_start_evidence"), false);
  }
  const bound2 = transition(pending2, "START_BOUND", { conversation: "CID2" });
  const steady2 = transition(bound2, "STEADY");
  assert.equal(canAct(steady2, steady2, "supervise_steady_execution"), true);
  assert.notEqual(steady2.S, steady1.S);
  assert.notEqual(steady2.G, steady1.G);

  // Failed state changes retain the confirmed tuple and forbid the dependent
  // action, so no two schedules or states become authoritative.
  assert.equal(canAct(steady1, steady1, "accept_handoff_conversation"), false);
  assert.equal(canAct(pending1, pending1, "recover_bound_execution"), false);
  assert.equal(canAct(advanceDelete1, advanceDelete1, "bootstrap_primary"), false);
  assert.equal(new Set([pending2.S]).size, 1);

  const terminal2 = transition(steady2, "TERMINAL_DELETE");
  assert.equal(canAct(terminal2, terminal2, "delete_terminal_schedule"), true);
  assert.equal(canAct(terminal2, terminal2, "stop_handoff_primary"), false);
  assert.equal(canAct(terminal2, terminal2, "bootstrap_primary"), false);

  assert.match(controller, /before recovery, supervision, or ending the Controller turn/i);
  assert.match(controller, /accepted CID observed in `START_BOUND` or `STEADY`[\s\S]*no Task action/i);
  assert.match(controller, /`ADVANCE_STOP`[\s\S]*do not accept/i);
  assert.match(controller, /Deletion failure[\s\S]*forbids fork or schedule creation/i);
  assert.match(controller, /`TERMINAL_DELETE`[\s\S]*never forks/i);
  for (const source of [controllerSpec, lifecycle]) {
    assert.match(source, /START_PENDING[\s\S]*START_BOUND[\s\S]*STEADY/);
    assert.match(source, /ADVANCE_STOP[\s\S]*ADVANCE_DELETE/);
    assert.match(source, /TERMINAL_DELETE/);
    assert.match(source, /revision|`R`/i);
    assert.match(source, /read.back/i);
  }
  assert.doesNotMatch(deliveryLoop, /Immediately before forking Primary[\s\S]{0,120}one-minute heartbeat/i);
  assert.match(deliveryLoop, /`START_PENDING`[\s\S]*uncommitted[\s\S]*`START_BOUND`/);
  assert.match(deliveryLoop, /`ADVANCE_STOP`[\s\S]*accepts[\s\S]*stops[\s\S]*`ADVANCE_DELETE`/);
});

test("handling-user-requests presents one task-scoped setup and execution profile choice", async () => {
  const skill = await read(
    "implementation/skills/handling-user-requests/SKILL.md",
  );
  const role = await read("implementation/components/roles/controller/role.md");
  const profileSource = JSON.parse(await read(
    "implementation/contents/welcome/execution-profiles.json",
  ));
  const guide = await read(
    "implementation/contents/welcome/initialization-guide.md",
  );
  const illustration = await readFile(path.join(
    repositoryRoot,
    "implementation/contents/welcome/welcome-loop.png",
  ));

  assert.match(profileSource.recordedAt, /^2026-08-08T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
  assert.deepEqual(profileSource.benchmark, {
    name: "Artificial Analysis Intelligence Index",
    version: "v4.1.1",
    sourceUrl: "https://artificialanalysis.ai/models/gpt-5-6-terra-medium",
  });
  assert.deepEqual(
    profileSource.models.map(({ id, recommendedPlan }) => [id, recommendedPlan]),
    [
      ["luna-max", "Plus"],
      ["terra-medium", "Plus"],
      ["sol-low", "Pro 5x"],
      ["sol-medium", "Pro 20x"],
    ],
  );
  assert.deepEqual(
    profileSource.models.map(({ aaScore }) => aaScore),
    [52, 47, 51, 56],
  );
  assert.deepEqual(
    profileSource.models.map(({ aaCostUsd }) => aaCostUsd),
    [172, 192, 344, 580],
  );
  assert.deepEqual(
    profileSource.models.map(({ aaTimeSeconds }) => aaTimeSeconds),
    [108, 37, 46, 79],
  );
  assert.ok(profileSource.models.every((model) => (
    !Object.hasOwn(model, "completionCostUsd")
    && !Object.hasOwn(model, "outputTokensPerSecond")
    && !Object.hasOwn(model, "ttftSeconds")
  )));
  assert.deepEqual(
    profileSource.models.map(({ model, reasoningEffort }) => [model, reasoningEffort]),
    [
      ["gpt-5.6-luna", "max"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-sol", "low"],
      ["gpt-5.6-sol", "medium"],
    ],
  );
  assert.deepEqual(
    profileSource.speeds.map(({ id, serviceTier }) => [id, serviceTier]),
    [
      ["normal", null],
      ["fast", "priority"],
    ],
  );
  assert.equal(profileSource.speeds[1].speedMultiplier, 1.5);
  assert.equal(profileSource.speeds[1].tokenMultiplier, 2.5);
  assert.deepEqual(profileSource.defaultProfile, {
    modelId: "terra-medium",
    speedId: "normal",
    summary: "the standard profile",
  });
  assert.ok(
    profileSource.models.every(({ summary }) => /^[\x20-\x7E]+$/.test(summary)),
    "model summaries remain English ASCII copy",
  );
  assert.ok(illustration.length > 20_000 && illustration.length < 2_000_000);
  assert.deepEqual(
    [...illustration.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );

  assert.doesNotMatch(guide, /<\/?(?:html|head|body|table|img)\b/i);
  assert.match(guide, /Welcome to Codex Small Loop/i);
  assert.match(guide, /Use AI with Loop Engineering\./i);
  assert.match(guide, /Slack/i);
  assert.match(guide, /Obsidian/i);
  assert.match(guide, /Recommended Tools/i);
  assert.match(guide, /Slack Plugin/i);
  assert.match(guide, /Obsidian App/i);
  assert.doesNotMatch(guide, /Recommended Integrations/i);
  assert.match(guide, /The following tools make development easier\./i);
  assert.match(guide, /\{\{WELCOME_IMAGE_ABSOLUTE_PATH\}\}/);
  assert.match(guide, /Luna Max/i);
  assert.match(guide, /Terra Medium/i);
  assert.match(guide, /Sol Low/i);
  assert.match(guide, /Sol Medium/i);
  assert.match(guide, /AA Score/i);
  assert.match(guide, /AA Cost/i);
  assert.match(guide, /AA Time/i);
  assert.match(guide, /108 sec/i);
  assert.match(guide, /\b1x\b/i);
  assert.match(guide, /1\.5/i);
  assert.match(guide, /Let's choose the Agent model\./i);
  assert.match(guide, /Execution Speed/i);
  assert.doesNotMatch(guide, /^### Execution Profile$/im);
  assert.doesNotMatch(guide, /Execution Time/i);
  assert.ok(
    guide.indexOf("### Next Action") < guide.indexOf("| Model |"),
    "model selection belongs to Next Action",
  );
  assert.doesNotMatch(guide, /About\s+(?:\d|1\.5x|2\.5x)/i);
  assert.match(
    guide,
    /May I start with the standard Terra Medium model\?/i,
  );
  assert.match(guide, /Unless you explicitly select 1\.5x, execution remains at 1x/i);

  assert.match(role, /selected model and\s+reasoning effort exactly/i);
  assert.match(role, /default.*1x speed.*priority.*1\.5x speed/is);
  assert.match(role, /Primary.*resolved.*execution profile/is);
  assert.equal(
    role.match(/components\/commands\/board\.mjs ensure/g)?.length,
    1,
  );

  assert.match(skill, /first Codex Small Loop turn|first.*Root Task/is);
  assert.match(skill, /conversation (?:context|history)/i);
  assert.match(skill, /no persistent|does not persist|without persisting/i);
  assert.match(skill, /welcome\s+(?:guide|Markdown)/i);
  assert.match(skill, /every.*Root Task|each.*Root Task/is);
  assert.match(skill, /Terra Medium/i);
  assert.match(skill, /latest\s+user-authored\s+message/i);
  assert.match(skill, /Speed defaults immediately to 1x/i);
  assert.match(skill, /Do not ask a speed-only follow-up/i);
  assert.match(skill, /Use 1\.5x only when the\s+user explicitly selects it/i);
  assert.match(skill, /reply containing only `Sol Medium` resolves to Sol Medium and\s+1x/is);
  assert.match(skill, /ask only for the model/i);
  assert.match(
    skill,
    /contents\/welcome\/execution-profiles\.json/,
  );
  assert.match(
    skill,
    /contents\/welcome\/initialization-guide\.md/,
  );
  assert.match(skill, /contents\/welcome\/welcome-loop\.png/);
  assert.match(skill, /Markdown/i);
  assert.match(skill, /Slack/i);
  assert.match(skill, /Obsidian/i);
  assert.match(skill, /every time|always/i);
  assert.match(skill, /absolute.*path|path.*absolute/i);
  assert.match(skill, /final response/i);
  assert.match(skill, /visible text/i);
  assert.match(skill, /user's language|user-authored message/i);
  assert.match(skill, /Next Action/i);
  assert.match(skill, /next user-authored turn/i);
  assert.match(skill, /inspect neither\s+the project nor connector state/i);
  assert.doesNotMatch(skill, /ask for agreement again/i);
  assert.doesNotMatch(skill, /ask.*priority|show.*priority/is);
  assert.doesNotMatch(skill, /\.obsidian|visualize:visualize|::codex-inline-vis/is);
  assert.doesNotMatch(role, /visualize:visualize|contents\/welcome|serviceTier/);

  const welcomeIndex = skill.indexOf("initialization-guide.md");
  const roleLoadingIndex = skill.indexOf("components/commands/role.mjs controller");
  assert.ok(welcomeIndex >= 0 && welcomeIndex < roleLoadingIndex);
});

test("Codex Small Loop owns a scoped interview adapter without replacing generic interview skills", async () => {
  const interview = await read("implementation/skills/interview-me/SKILL.md");
  const metadata = await read("implementation/skills/interview-me/agents/openai.yaml");
  const upstream = await read(
    "implementation/third_party/agent-skills/interview-me/SKILL.md",
  );
  const upstreamMetadata = await read(
    "implementation/third_party/agent-skills/UPSTREAM.md",
  );
  const updateCommand = await read(
    "implementation/third_party/agent-skills/update-interview-me.mjs",
  );
  const notices = await read("implementation/THIRD_PARTY_NOTICES.md");
  const license = await read("implementation/third_party/agent-skills/LICENSE");

  assert.match(interview, /name:\s*interview-me/);
  assert.match(interview, /description:\s*Use only when/i);
  assert.match(interview, /Codex Small Loop/i);
  assert.match(interview, /material ambiguity/i);
  assert.match(interview, /interactive/i);
  assert.match(interview, /plugin root/i);
  assert.match(
    interview,
    /third_party\/agent-skills\/interview-me\/SKILL\.md/i,
  );
  assert.match(interview, /read[\s\S]{0,160}(?:entire|completely)/i);
  assert.match(interview, /one question at a time/i);
  assert.match(interview, /confirmed statement of intent/i);
  assert.match(interview, /Controller/i);
  assert.match(interview, /plan/i);
  assert.match(interview, /generic|external/i);
  assert.match(metadata, /display_name:\s*"codex-small-loop:interview-me"/);
  assert.match(metadata, /\$codex-small-loop:interview-me/);
  assert.match(metadata, /allow_implicit_invocation:\s*false/);
  assert.match(upstream, /name:\s*interview-me/);
  assert.match(upstream, /95% Confidence Stop/i);
  assert.match(
    upstreamMetadata,
    /7829ffd90d973b6325f5f12f1b1226dcace74443/,
  );
  assert.match(upstreamMetadata, /git subtree/i);
  assert.match(upstreamMetadata, /update-interview-me\.mjs/);
  assert.match(updateCommand, /--verify-local/);
  assert.match(updateCommand, /--check/);
  assert.match(updateCommand, /--apply/);
  assert.match(updateCommand, /exact 40-character reviewed commit/i);
  assert.match(updateCommand, /clean worktree/i);
  assert.match(updateCommand, /LICENSE changed/i);
  assert.match(notices, /Addy Osmani/);
  assert.match(notices, /agent-skills/i);
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2025 Addy Osmani/);
});

test("Sonner ships the pinned EPL-2.0 ELK browser layout artifact", async () => {
  const bundle = await read("implementation/components/board/public/vendor/elk.bundled.js");
  const upstream = await read("implementation/third_party/elkjs/UPSTREAM.md");
  const license = await read("implementation/third_party/elkjs/LICENSE.md");
  const notices = await read("implementation/THIRD_PARTY_NOTICES.md");
  const distribution = await read("specification/technical-specification/package/plugin-distribution.md");
  const digest = createHash("sha256").update(bundle).digest("hex");

  assert.equal(digest, "1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3");
  assert.match(upstream, /Package: `elkjs`/);
  assert.match(upstream, /Version: `0\.12\.0`/);
  assert.match(upstream, new RegExp(digest));
  assert.match(license, /Eclipse Public License - v 2\.0/);
  assert.match(notices, /## elkjs/);
  assert.match(distribution, /public\/vendor/);
  assert.match(distribution, /ELK is an internal Sonner layout dependency/);
});

test("primary role is explicitly installed", async () => {
  const primary = await read("implementation/components/roles/primary/role.md");

  assert.match(primary, /^---\nsummary:/);
  assert.doesNotMatch(primary, /default job role|no (explicit )?job role|unspecified/i);
  assert.match(primary, /Milestone trajectory/i);
  assert.match(primary, /one delegated Milestone/i);
  assert.match(primary, /delegat/i);
  assert.match(primary, /do not accept or begin a later Milestone/i);
  assert.match(primary, /outcome/i);
  assert.match(primary, /acceptance/i);
  assert.match(primary, /authority/i);
  assert.match(primary, /discoverable|inspect.*before asking/is);
  assert.match(primary, /method|Work/i);
  assert.match(primary, /delivery|lifecycle/i);
  assert.match(primary, /review|CI/i);
  assert.match(primary, /parent communication/i);
  assert.match(primary, /ambiguity|judgment/i);
  assert.match(primary, /evidence/i);
  assert.match(primary, /accepted/i);
  assert.match(primary, /verif/i);
  assert.match(primary, /authority-gated autonomy/i);
  assert.doesNotMatch(primary, /sending-user-notifications/i);
  assert.match(primary, /parent/i);
  assert.match(primary, /consequential/i);
  assert.match(
    primary,
    /implementation(?:-level)? (?:choices|details).*autonomously/is,
  );
  assert.match(primary, /premise.*(?:upstream|parent) judgment/is);
});

test("primary coordinates milestone-scoped execute and four parallel review responsibilities", async () => {
  const primary = await read("implementation/components/roles/primary/role.md");
  const controller = await read("implementation/components/roles/controller/role.md");

  assert.match(primary, /conversation context/i);
  assert.match(primary, /read.*files|inspect.*files/is);
  assert.match(primary, /diff/i);
  assert.match(primary, /test/i);
  assert.match(primary, /logs?/i);
  assert.match(primary, /must not modify|does not modify/i);
  assert.match(primary, /sole writable[\s\S]*Signal file/is);
  assert.match(primary, /every Milestone/i);
  assert.match(primary, /fresh.*execute.*fork/is);
  assert.match(primary, /returned.*Task ID/is);
  assert.match(primary, /never\s+(?:search|explore|rediscover).*Task ID/is);
  assert.match(primary, /same.*Execute Task/is);
  assert.match(primary, /same problem context/is);
  assert.match(primary, /different problem contexts.*sequential/is);
  assert.match(primary, /change volume|file count/i);
  assert.match(primary, /all.*problem contexts.*before.*Review/is);
  assert.match(
    primary,
    /do(?:es)? not create (?:a )?fresh Execute Task.*Review correction/is,
  );
  assert.match(primary, /Review Plan/i);
  assert.match(primary, /snapshot.*each Review pass/is);
  assert.match(primary, /previousSnapshot/i);
  assert.match(primary, /currentSnapshot/i);
  assert.match(primary, /exact.*diff command/is);
  assert.match(primary, /all four.*same snapshot pair/is);
  assert.match(primary, /not a required document format/i);
  assert.match(primary, /never removes (?:a responsibility|one)/i);
  assert.match(primary, /Customer Value Review/i);
  assert.match(primary, /Technical Excellence Review/i);
  assert.match(primary, /Trust Review/i);
  assert.match(primary, /Baseline Verification/i);
  assert.doesNotMatch(primary, /Outcome Review|Integrity Review|Operability Review/i);
  assert.match(primary, /outcome goals?.*not.*(?:fixed|exhaustive).*checklists?/is);
  assert.match(primary, /full test suite/i);
  assert.match(primary, /build|compile/i);
  assert.match(primary, /lint|typecheck/i);
  assert.match(primary, /four Review.*responsibilities.*parallel/is);
  assert.match(primary, /parallel.*reduce overall Review time/is);
  assert.match(primary, /No Review responsibility is a serial gate for another/i);
  assert.match(primary, /same candidate/i);
  assert.match(primary, /parallel/i);
  assert.match(primary, /review.*read-only|review work as read-only/is);
  assert.match(primary, /wait for all\s+four/i);
  assert.match(primary, /integrat/i);
  assert.match(primary, /no\s+separate\s+Integration\s+Review/i);
  assert.match(primary, /contents\/review\/signal-evaluation\.md/);
  assert.match(primary, /every Signal[\s\S]*final severity/is);
  assert.match(primary, /signal\.mjs set-severity/);
  assert.match(primary, /only[\s\S]*`required`[\s\S]*Interview[\s\S]*Execute/is);
  assert.match(primary, /Review Task ID.*already.*remember|remember.*Review Task ID/is);
  assert.match(primary, /do\s+not\s+(?:search|explore|rediscover).*Review Task/is);
  assert.match(
    primary,
    /later Review pass[\s\S]*working-with-codex-tasks[\s\S]*Role reload/i,
  );
  assert.match(primary, /every planned exploration\s+axis.*initial\s+handoff/is);
  assert.match(primary, /do not continue Review.*hypothetical question/is);
  assert.match(primary, /material impact (?:area|surface)/i);
  assert.match(primary, /everything that changed/i);
  assert.match(
    primary,
    /Interviewer.*fork[\s\S]*--source.*Execute|fork.*Execute.*context/is,
  );
  assert.match(
    primary,
    /Group.*Signals.*`required`.*problem context/is,
  );
  assert.match(primary, /representative.*`required`/is);
  assert.match(primary, /duplicate.*`dismiss`/is);
  assert.match(primary, /Explanation.*representative Signal/is);
  assert.match(primary, /resume.*same.*Execute|same.*Execute.*resume/is);
  assert.match(primary, /cannot be resumed|cannot accept/i);
  assert.match(primary, /do not fall back/i);
  assert.match(primary, /commit|push|merge/i);
  assert.match(primary, /delivery/i);
  assert.match(primary, /report.*Controller|Controller.*report/is);
  assert.match(primary, /must not.*user.*directly|does not.*user.*directly/is);
  assert.match(primary, /must not.*Slack|does not.*Slack/is);
  assert.match(primary, /Controller.*explicitly.*skip.*Review/is);
  assert.doesNotMatch(primary, /Primary owns final delivery/i);
  assert.doesNotMatch(primary, /acceptance, or delivery back to the parent/i);

  assert.match(controller, /one fresh Primary for each Milestone/i);
  assert.doesNotMatch(controller, /four-review batch|four Review Children/i);
});

test("controller alone grounds milestones in the Work Graph", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");
  const primary = await read("implementation/components/roles/primary/role.md");
  const execute = await read("implementation/components/roles/execute/role.md");
  const review = await read("implementation/components/roles/review/role.md");
  const coordination = await read("implementation/skills/working-with-codex-tasks/SKILL.md");

  assert.match(controller, /understanding-works/i);
  assert.match(controller, /Work Graph/i);
  assert.match(controller, /intended outcome/i);
  assert.match(controller, /acceptance evidence/i);
  assert.match(controller, /not the Codex Task boundary/i);
  assert.match(controller, /clearly agreed/i);
  assert.match(controller, /material topology/i);

  assert.match(controller, /before every Primary assignment[\s\S]*Work (?:Graph|context)/is);
  assert.match(primary, /Controller-supplied Work context/i);
  assert.doesNotMatch(primary, /work-map\.mjs|understanding-works/i);
  assert.doesNotMatch(execute, /Work Graph|work-map\.mjs|understanding-works|WORK_NODE\.xml|updated.*unaffected.*limit/is);
  assert.doesNotMatch(review, /Work Graph|work-map\.mjs|understanding-works|WORK_NODE\.xml|updated.*unaffected.*limit/is);

  assert.match(coordination, /mechanical operation requested by the caller/i);
  assert.doesNotMatch(coordination, /Work Graph|Task is a transformation|output Work/i);
});

test("execute and review roles are explicitly installed", async () => {
  const execute = await read(
    "implementation/components/roles/execute/role.md",
  );
  const review = await read(
    "implementation/components/roles/review/role.md",
  );

  assert.match(execute, /^---\nsummary:/);
  assert.match(execute, /Job Role/i);
  assert.match(execute, /modify/i);
  assert.match(execute, /assignment/i);
  assert.match(execute, /test|verify/i);
  assert.match(execute, /direct Parent|incoming Conversation/i);
  assert.match(execute, /working-with-codex-tasks[\s\S]*reply/is);
  assert.match(execute, /does not accept.*incoming Conversation/is);
  assert.match(execute, /same Execute Task/i);
  assert.match(execute, /later Review\s+corrections/i);
  assert.match(execute, /current problem context/i);
  assert.match(execute, /do not.*later.*problem context/is);
  assert.match(
    execute,
    /read every supplied required Signal[\s\S]*before\s+modifying project files/is,
  );
  assert.match(execute, /same problem context.*correction/is);
  assert.match(execute, /different problem contexts.*separate.*Conversation/is);
  assert.match(
    execute,
    /overlapping change locations[\s\S]*constraints[\s\S]*combined result/is,
  );
  assert.match(execute, /every\s+supplied\s+Signal[\s\S]*covered/is);
  assert.match(execute, /conflict[\s\S]*Primary|Primary[\s\S]*conflict/is);
  assert.match(execute, /working-with-codex-tasks[\s\S]*reply/is);
  assert.doesNotMatch(execute, /correction uses a fresh Execute/i);

  assert.match(review, /^---\nsummary:/);
  assert.match(review, /Job Role/i);
  assert.match(review, /read-only/i);
  assert.match(review, /must not modify|does not modify/i);
  assert.match(review, /previousSnapshot/i);
  assert.match(review, /currentSnapshot/i);
  assert.match(review, /run.*supplied.*diff command/is);
  assert.match(review, /before.*broader.*review/is);
  assert.match(review, /Customer Value Review/i);
  assert.match(review, /Technical Excellence Review/i);
  assert.match(review, /Trust Review/i);
  assert.match(review, /Baseline Verification/i);
  assert.doesNotMatch(review, /Outcome Review|Integrity Review|Operability Review/i);
  assert.match(review, /outcome goals?.*not.*(?:fixed|exhaustive).*checklists?/is);
  assert.match(review, /agreed (?:outcome|scope)[\s\S]*customer|customer[\s\S]*agreed (?:outcome|scope)/is);
  assert.match(review, /technical excellence[\s\S]*simplicity[\s\S]*(?:continue|ongoing).*chang/is);
  assert.match(review, /broad.*mechanical checks|full test suite/is);
  assert.match(
    review,
    /preserve.*project files|write.*temporary isolation|isolat.*command.*write/is,
  );
  assert.match(review, /do not repeat.*broad.*baseline/is);
  assert.match(review, /targeted.*checks?|reproduce.*finding/is);
  assert.match(review, /evidence/i);
  assert.match(review, /no\s+fixed result schema/i);
  assert.match(review, /not\s+an\s+automatic veto/i);
  assert.match(review, /incoming Conversation/i);
});

test("interviewer turns required Review Signals into implementation guidance", async () => {
  const interviewer = await read(
    "implementation/components/roles/interviewer/role.md",
  );
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const review = await read(
    "implementation/components/roles/review/role.md",
  );
  const reviewReference = await read(
    "specification/system-specification/roles/review.md",
  );
  const interviewerReference = await read(
    "specification/system-specification/roles/interviewer.md",
  );
  const primaryReference = await read(
    "specification/system-specification/roles/primary.md",
  );
  const template = await read(
    "implementation/components/runtime/templates/signals/review-signal.md",
  );

  assert.match(interviewer, /^---\nsummary:/);
  assert.match(interviewer, /Interviewer Job Role/i);
  assert.match(interviewer, /existing Reviewer Task/i);
  assert.match(
    interviewer,
    /working-with-codex-tasks[\s\S]*start (?:a|one) new Conversation/is,
  );
  assert.match(interviewer, /Implementation Approach/i);
  assert.match(interviewer, /required Review Signals|Signals.*`required`/i);
  assert.match(
    interviewer,
    /actual (?:project )?files?[\s\S]*(?:change locations?|functions?|symbols?|sections?)/is,
  );
  for (const source of [
    interviewer,
    interviewerReference,
  ]) {
    assert.match(
      source,
      /deepen[\s\S]*implementation-ready/is,
    );
    assert.match(
      source,
      /adjacent\s+inputs?,\s+sibling\s+operations?,\s+states?,\s+failure\s+transitions?,\s+or\s+consumers?/i,
    );
    assert.match(
      source,
      /same (?:cause|invariant)[\s\S]*(?:same correction|same Signal)/is,
    );
    assert.match(
      source,
      /distinct cause[\s\S]*Primary/is,
    );
    assert.doesNotMatch(
      source,
      /Focus and Boundary Challenge loop/i,
    );
    assert.doesNotMatch(
      source,
      /boundary challenge.*again/is,
    );
    assert.match(
      source,
      /do not ask[\s\S]*(?:assume|all)[\s\S]*(?:fixed|implemented)[\s\S]*(?:what|other|remain)/is,
    );
    assert.match(
      source,
      /related[\s\S]*(?:question|topic)[\s\S]*(?:batch|group|one message|same message|same round)/is,
    );
    assert.match(source, /paired with exactly one existing\s+Reviewer Task/is);
    assert.match(
      source,
      /start(?:s)? one new Conversation[\s\S]*assigned existing Reviewer Task/is,
    );
    assert.match(
      source,
      /never\s+interviews or starts a\s+Conversation with another Reviewer/is,
    );
    assert.doesNotMatch(source, /Reviewer Conversations.*parallel/is);
    assert.match(source, /Primary[\s\S]*final severity|final severity[\s\S]*Primary/is);
    assert.match(source, /signal\.mjs set-severity/);
    assert.doesNotMatch(
      source,
      /signal\.mjs decide|disposition|`adopt`|`defer`|`reject`|`high`|`medium`|`low`/i,
    );
  }
  assert.match(
    interviewer,
    /(?:all|complete|entire)[\s\S]*Signal files?|Signal files?[\s\S]*(?:all|complete|entire)/is,
  );
  assert.match(interviewer, /no rigid template|not a rigid template/i);
  assert.match(interviewer, /report.*Primary/is);
  assert.match(interviewer, /problem.*Primary|Primary.*final severity/is);
  assert.match(interviewer, /interview.*may.*(?:revise|change|refine).*Signal/is);

  assert.match(primary, /group.*`required`.*implementation problem\s+context/is);
  assert.match(primary, /one new `interviewer` fork/is);
  assert.match(
    primary,
    /every\s+originating Reviewer.*`required` Signal[\s\S]*exactly one Reviewer Task/is,
  );
  assert.match(
    primary,
    /only that Reviewer's required Signals/is,
  );
  for (const source of [primary, primaryReference]) {
    assert.match(
      source,
      /independent\s+Interviewers in parallel.*reduce\s+overall\s+Interview\s+time/is,
    );
    assert.match(
      source,
      /No independent\s+Interviewer is a serial gate for another/i,
    );
  }
  assert.match(primary, /one direct Conversation.*assigned existing\s+Reviewer Task/is);
  assert.match(primary, /integrates the results across Reviewers/is);
  assert.match(
    primary,
    /wait for all.*Interviewer results[\s\S]*Before Execute/is,
  );
  assert.match(
    primary,
    /implementation-ready[\s\S]*same-cause[\s\S]*adjacent[\s\S]*actual\s+project\s+files[\s\S]*concrete\s+change\s+locations/is,
  );
  assert.match(
    review,
    /same (?:cause|invariant)[\s\S]*(?:same correction|same Signal)/is,
  );
  assert.match(
    interviewerReference,
    /deepen[\s\S]*implementation-ready[\s\S]*same-cause/is,
  );
  assert.match(
    primaryReference,
    /implementation-ready[\s\S]*same-cause[\s\S]*adjacent/is,
  );
  assert.match(primary, /same.*Execute Task/is);
  assert.match(primary, /Review Task ID.*already.*remember|remember.*Review Task ID/is);
  assert.match(
    review,
    /after.*initial.*handoff[\s\S]*Interviewer.*Conversation/is,
  );
  assert.match(
    reviewReference,
    /same existing[\s\S]{0,160}Execute[\s\S]{0,160}Task/is,
  );
  assert.doesNotMatch(
    reviewReference,
    /creates?\s+(?:a|one)\s+fresh[\s\S]{0,80}Execute/i,
  );
  assert.match(template, /## Implementation Approach/);
});

test("managed communication uses Conversation commands instead of task acceptance", async () => {
  const coordination = await read(
    "implementation/skills/working-with-codex-tasks/SKILL.md",
  );
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const execute = await read(
    "implementation/components/roles/execute/role.md",
  );

  for (const source of [coordination, primary, execute]) {
    assert.doesNotMatch(source, /task\.mjs accept|task accept/);
  }
  assert.match(coordination, /conversation\.mjs start[\s\S]*--task/is);
  assert.match(coordination, /conversation\.mjs reply[\s\S]*--conversation/is);
  assert.match(coordination, /conversation\.mjs continue[\s\S]*--conversation/is);
  assert.match(coordination, /conversation\.mjs accept[\s\S]*--conversation/is);
  assert.match(coordination, /MESSAGE_TARGET_BUSY/);
  assert.match(coordination, /one active incoming.*Conversation/is);
  assert.match(coordination, /stop.*resume.*Conversation.*branch/is);
});

test("task messaging separates one-way Notification from Conversation work", async () => {
  const coordination = await read(
    "implementation/skills/working-with-codex-tasks/SKILL.md",
  );
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const messageRouting = await read(
    "specification/technical-specification/runtime/conversations.md",
  );

  for (const source of [primary, messageRouting]) {
    assert.match(source, /reply.*work.*decision.*Conversation/is);
    assert.match(source, /information.*only.*notif/is);
  }
  assert.match(coordination, /message asks for work, a reply, or a decision/i);
  assert.match(coordination, /Information only.*Notification/i);
  assert.match(coordination, /message\.mjs notify[\s\S]*--task/is);
  assert.match(coordination, /managed or unmanaged/i);
  assert.match(coordination, /no reply or acknowledgement is required/i);
  assert.match(messageRouting, /Conversation.*not created/is);
  assert.match(messageRouting, /replyExpected.*false/is);
});

test("review coverage is planned before checking and completed before handoff", async () => {
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const review = await read(
    "implementation/components/roles/review/role.md",
  );
  assert.match(primary, /minimum material exploration axes/i);
  assert.match(primary, /floor, not a ceiling/i);

  assert.match(
    review,
    /before (?:running|starting) broader checks.*enumerate.*material exploration axes/is,
  );
  assert.match(review, /add.*axes.*Primary.*did not include/is);
  assert.match(review, /finding is not a stop condition/i);
  assert.match(review, /PASS[\s\S]*FINDING[\s\S]*LIMIT/);
  assert.match(review, /every planned axis.*accounted for/is);

});

test("managed tasks inherit one explicit three-field execution profile", async () => {
  const coordination = await read(
    "implementation/skills/working-with-codex-tasks/SKILL.md",
  );
  const launch = await read(
    "specification/technical-specification/runtime/task-coordination.md",
  );
  const ledger = await read(
    "specification/technical-specification/runtime/project-runtime.md",
  );

  for (const source of [coordination, launch]) {
    assert.match(source, /--service-tier <tier/);
    assert.match(source, /Parent.*effective/is);
    assert.match(source, /model.*reasoning effort.*service tier/is);
    assert.match(source, /service tier.*independent/is);
    assert.match(source, /pass(?:es)? all three explicitly|resolved three-field profile explicitly|passes model, reasoning effort, service tier/is);
  }

  assert.match(launch, /default.*normal Codex tier.*null/is);

  assert.match(launch, /Role.*Assignment.*message.*Recovery/is);
  assert.match(ledger, /schema version 10/i);
  assert.match(ledger, /serviceTier/i);
  assert.match(ledger, /no migration path from earlier prototype ledgers/i);
});

test("review records findings as Signals without prescribing implementation", async () => {
  const review = await read(
    "implementation/components/roles/review/role.md",
  );
  const reviewReference = await read(
    "specification/system-specification/roles/review.md",
  );
  const template = await read(
    "implementation/components/runtime/templates/signals/review-signal.md",
  );

  for (const source of [review, reviewReference]) {
    assert.match(
      source,
      /(?:one|every) material finding.*one (?:Review )?signal file/is,
    );
    assert.match(source, /signal\.mjs create/);
    assert.match(
      source,
      /--task[\s\S]*--snapshot[\s\S]*--name[\s\S]*--template review-signal/,
    );
    assert.doesNotMatch(
      source,
      /## Proposed correction|records?.{0,80}Proposed correction|including.{0,80}proposed correction/is,
    );
    assert.match(
      source,
      /does not prescribe|do not prescribe.*(?:implementation|correction)/is,
    );
    assert.match(source, findingSignalPathContractPattern);
    assert.match(source, /authoritative (?:finding\s+)?record/i);
    assert.match(
      source,
      /handoff[\s\S]*(?:may|can)\s+include[\s\S]*(?:coverage|PASS|LIMIT)[\s\S]*cross-cutting[\s\S]*(?:concise|useful)\s+context/is,
    );
    assert.doesNotMatch(
      source,
      forbiddenPathOnlyHandoffPattern,
    );
  }

  for (const source of [review, reviewReference]) {
    assert.match(source, /contents\/review\/signal-evaluation\.md/);
    assert.match(source, /single source of truth|owns all severity/i);
    assert.match(source, /required[\s\S]*consider[\s\S]*later[\s\S]*dismiss/i);
    assert.match(source, /Explanation/i);
    assert.match(source, /severity[\s\S]*summary/i);
    assert.match(
      source,
      /accurate[\s\S]{0,40}classification|classif(?:y|ication)[\s\S]{0,40}accurate/i,
    );
    assert.match(source, /not[\s\S]{0,80}(?:produce|find)[\s\S]{0,40}`required`/i);
    assert.doesNotMatch(source, /`high`|`medium`|`low`|disposition|decision/i);
  }

  assert.match(
    review,
    /only.*\.codex-small-loop\/signals.*(?:write|modify)|only.*(?:write|modify).*\.codex-small-loop\/signals/is,
  );
  assert.match(review, /candidate.*read-only|read-only.*candidate/is);
  assert.equal(
    template,
    [
      "---",
      "template: review-signal",
      'severity: "<required | consider | later | dismiss>"',
      'summary: "<Concise one-line summary of the material finding>"',
      "---",
      "",
      "## Explanation",
      "",
      "<Explain the finding and why the selected severity is accurate.>",
      "",
      "## Implementation Approach",
      "",
      "<During Interview, describe the agreed implementation approach. Review leaves this placeholder unchanged.>",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(template, /decided_by|^decision:/mi);
  assert.doesNotMatch(template, /## Evidence/i);
});

test("review handoff checks bind signal paths to every finding and reject former path-only wording", async () => {
  for (const requiredContract of [
    "Each FINDING must provide its Review signal file path.",
    "Each `FINDING` gives its signal file path.",
    "A `FINDING` entry gives the Review signal file path.",
    `For a FINDING, provide
its Review signal file path.`,
  ]) {
    assert.match(requiredContract, findingSignalPathContractPattern);
  }

  for (const optionalOrSeparatedContract of [
    "The handoff may mention a signal path when useful.",
    "Each FINDING may include its signal file path when useful.",
    "For a FINDING, provide supporting context. Its Review signal file path is listed later.",
    `For a FINDING, provide

its Review signal file path.`,
  ]) {
    assert.doesNotMatch(
      optionalOrSeparatedContract,
      findingSignalPathContractPattern,
    );
  }

  assert.match(
    `For a FINDING, provide${"-".repeat(80)}Review signal file path.`,
    findingSignalPathContractPattern,
  );
  assert.doesNotMatch(
    `For a FINDING, provide${"-".repeat(81)}Review signal file path.`,
    findingSignalPathContractPattern,
  );

  for (const formerContract of [
    "The signal file is the finding record: do not repeat the finding details, evidence, or proposed correction in the handoff.",
    "The handoff does not repeat the finding details, evidence, or proposed correction.",
    "Finding details, evidence, or proposed correction do not repeat in the handoff.",
    `The handoff does not repeat
the finding details, evidence, or proposed correction.`,
    `Finding details, evidence, or proposed correction
do not repeat in the handoff.`,
  ]) {
    assert.match(formerContract, forbiddenPathOnlyHandoffPattern);
  }

  for (const sourcePath of [
    "implementation/components/roles/review/role.md",
    "specification/system-specification/roles/review.md",
  ]) {
    const source = await read(sourcePath);
    assert.match(source, findingSignalPathContractPattern);
    assert.doesNotMatch(source, forbiddenPathOnlyHandoffPattern);
  }
});

test("primary finalizes every Review Signal severity before Interview and Execute", async () => {
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const primaryReference = await read(
    "specification/system-specification/roles/primary.md",
  );
  for (const source of [primary, primaryReference]) {
    assert.match(source, /wait(?:s)?\s+for all\s+four.*signal\.mjs list/is);
    assert.match(source, /signal\.mjs list/);
    assert.match(source, /--task[\s\S]*--snapshot/);
    assert.match(source, /currentSnapshot/);
    assert.match(source, /contents\/review\/signal-evaluation\.md/);
    assert.match(source, /read every.*Signal/is);
    assert.match(source, /owns?.*final severity|final severity.*Primary/is);
    assert.match(source, /raise or lower|lower or raise/i);
    assert.match(source, /signal\.mjs set-severity/);
    assert.match(
      source,
      /--name[\s\S]*--severity[\s\S]*(?:required|consider|later|dismiss)/,
    );
    assert.match(
      source,
      /Explanation[\s\S]*(?:support|establish)[\s\S]*`required`/is,
    );
    assert.match(
      source,
      /`required`[\s\S]*Interviewer[\s\S]*(?:new|fresh).*Execute/is,
    );
    assert.match(
      source,
      /no Signal\s+remains `required`|none\s+remain `required`/i,
    );
    assert.match(
      source,
      /(?:no|not create).*empty.*(?:Interviewer|Execute)/is,
    );
    assert.match(
      source,
      /consider[\s\S]*later[\s\S]*dismiss[\s\S]*(?:no|not create).*Interviewer/is,
    );
    assert.match(
      source,
      /consider[\s\S]*later[\s\S]*dismiss[\s\S]*not[\s\S]*future Milestone|not[\s\S]*carry[\s\S]*future Milestone/is,
    );
    assert.doesNotMatch(
      source,
      /Assume all Signals you have reported[\s\S]*other important locations/i,
    );
    assert.match(
      source,
      /(?:before Execute[\s\S]*(?:list|reread)|(?:list|reread)[\s\S]*before Execute)[\s\S]*(?:final severity|`required`)/is,
    );
    assert.doesNotMatch(
      source,
      /signal\.mjs decide|disposition|`adopt`|`defer`|`reject`|`high`|`medium`|`low`/i,
    );
  }
});

test("primary may escalate consultation in any phase without returning routine work", async () => {
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const primaryReference = await read(
    "specification/system-specification/roles/primary.md",
  );

  for (const source of [primary, primaryReference]) {
    assert.match(source, /any phase|not limited to Review/i);
    assert.match(source, /routine[\s\S]*Milestone[\s\S]*(?:final|result|handoff)/i);
    assert.match(source, /consult|escalat/i);
    assert.match(source, /Controller/i);
    assert.match(source, /does not transfer|without transferring/i);
  }
});

test("Signal cutover fails closed on legacy Review Issue records", async () => {
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const signalReference = await read(
    "specification/technical-specification/runtime/review-snapshots-and-signals.md",
  );

  for (const source of [primary]) {
    assert.match(source, /SIGNAL_LEGACY_ISSUES_PRESENT/);
    assert.match(source, /SIGNAL_INVALID_RECORDS/);
    assert.match(source, /snapshot\.mjs create/);
    assert.match(source, /--force-new/);
    assert.match(source, /unchanged/);
    assert.match(source, /same four Review Tasks|four persistent Review Tasks/i);
    assert.match(source, /(?:instead of|rather than).*empty/is);
  }
  assert.match(signalReference, /SIGNAL_LEGACY_ISSUES_PRESENT/);
  assert.match(signalReference, /SIGNAL_INVALID_RECORDS/);
  assert.match(signalReference, /--force-new/);
  assert.match(signalReference, /never silently interpreted as Signals/i);
  assert.match(signalReference, /old files\s+remain untouched/i);
});

test("role command reads one explicitly selected installed role", async () => {
  const command = await read("implementation/components/commands/role.mjs");
  const loader = await read("implementation/components/runtime/source/role-loader.mjs");

  assert.match(command, /argv\.length !== 1/);
  assert.match(command, /loadRole\(role/);
  assert.match(loader, /components|role\.md/i);
  assert.match(loader, /ROLE_NAME_INVALID/);
  assert.match(loader, /ROLE_NOT_FOUND/);
  assert.equal(await exists("implementation/skills/loading-job-role"), false);
});

test("task coordination owns explicit runtime diagnosis", async () => {
  const coordination = await read("implementation/skills/working-with-codex-tasks/SKILL.md");
  assert.match(coordination, /initialize.*private project runtime[\s\S]*automatically/is);
  assert.match(coordination, /runtime\.mjs status.*--project-root/is);
  assert.match(coordination, /runtime\.mjs repair/i);
  assert.match(coordination, /compacts terminal records/i);
  assert.doesNotMatch(coordination, /codex-small-loop-doctor/i);
  assert.equal(await exists("implementation/skills/codex-small-loop-doctor"), false);
});

test("unavailable App schedules recover through the Codex Small Loop boundary", async () => {
  const recovery = await read(
    "implementation/skills/recover-unavailable-thread-schedules/SKILL.md",
  );
  const metadata = await read(
    "implementation/skills/recover-unavailable-thread-schedules/agents/openai.yaml",
  );
  const specification = await read(
    "specification/system-specification/skills/recover-unavailable-thread-schedules.md",
  );
  const coordination = await read(
    "implementation/skills/working-with-codex-tasks/SKILL.md",
  );

  for (const source of [recovery, specification]) {
    assert.match(source, /automation_update/);
    assert.match(source, /local-thread restriction|local threads/i);
    assert.match(source, /exact.*target Task|target Task.*exact/is);
    assert.match(source, /schedule apply\/read\/delete|schedule\.mjs (?:apply|read|delete)/i);
    assert.match(source, /opaque.*etag|etag.*exact read/is);
    assert.match(source, /real Heartbeat Turn/i);
    assert.match(source, /two eligible intervals/i);
    assert.doesNotMatch(source, /automation-store\.mjs|automation-backups/);
  }
  assert.match(recovery, /Do not\s+create a relay Task/i);
  assert.match(recovery, /Never edit,\s*move, or enumerate automation TOML directly/i);
  assert.match(metadata, /codex-small-loop:recover-unavailable-thread-schedules/);
  assert.match(metadata, /\$codex-small-loop:recover-unavailable-thread-schedules/);
  assert.match(coordination, /\$codex-small-loop:recover-unavailable-thread-schedules/);
});

test("working-with-codex-tasks owns mechanics while Roles own workflow", async () => {
  const skill = await read("implementation/skills/working-with-codex-tasks/SKILL.md");
  const roles = await Promise.all([
    "controller",
    "primary",
    "execute",
    "review",
    "interviewer",
  ].map((role) => read(`implementation/components/roles/${role}/role.md`)));

  assert.match(skill, /name:\s*working-with-codex-tasks/);
  assert.match(skill, /task\.mjs (?:create|fork)/);
  assert.match(skill, /task\.mjs stop/);
  assert.match(skill, /task\.mjs resume/);
  assert.match(skill, /message\.mjs notify/);
  assert.match(skill, /conversation\.mjs start/);
  assert.match(skill, /conversation\.mjs reply/);
  assert.match(skill, /conversation\.mjs continue/);
  assert.match(skill, /conversation\.mjs accept/);
  assert.match(skill, /schedule\.mjs apply/);
  assert.match(skill, /schedule\.mjs read/);
  assert.match(skill, /schedule\.mjs delete/);
  assert.match(skill, /--if-match absent/);
  assert.match(skill, /opaque.*etag/is);
  assert.match(skill, /Do not use Codex App `automation_update`/i);
  assert.match(skill, /--reload-role/);
  assert.match(skill, /runtime\.mjs status/);
  assert.match(skill, /runtime\.mjs repair/);
  assert.match(skill, /structured.*non-ok|run.*other than.*ok/is);
  assert.match(skill, /Caller.*decides.*when|when.*belongs.*caller/is);
  assert.doesNotMatch(
    skill,
    /snapshot\.mjs|signal\.mjs|Milestone|Baseline Verification|Trust Review|Technical Excellence Review|Customer Value Review|Interviewer/i,
  );

  for (const role of roles) {
    assert.match(role, /\$codex-small-loop:working-with-codex-tasks/);
    assert.doesNotMatch(
      role,
      /(?:components\/commands\/)?(?:task|conversation|message|runtime)\.mjs/,
    );
  }

  assert.equal(await exists("implementation/skills/coordinating-codex-tasks"), false);
});

test("sending-user-notifications belongs to the Controller boundary", async () => {
  const skill = await read("implementation/skills/sending-user-notifications/SKILL.md");
  const controller = await read("implementation/components/roles/controller/role.md");
  const controllerSpec = await read(
    "specification/system-specification/roles/controller.md",
  );

  assert.match(skill, /name:\s*sending-user-notifications/);
  assert.match(skill, /description:\s*Use when/i);
  assert.match(skill, /completion|complete/i);
  assert.match(skill, /parent/i);
  assert.match(skill, /Controller/i);
  assert.match(skill, /unrecoverable/i);
  assert.match(skill, /completion|complete/i);
  assert.match(skill, /must not be missed/i);
  assert.match(skill, /reminder/i);
  assert.match(skill, /one-way|attention signal/i);
  assert.match(skill, /1 minute ago/i);
  assert.match(skill, /reminder\s+tool.*time/is);
  assert.match(skill, /fixed|literal/i);
  assert.match(skill, /past.*immediate/is);

  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.doesNotMatch(frontmatter, /Slack/i);

  const terminalBoundary = controller.indexOf(
    "At verified completion or an unrecoverable stop:",
  );
  const deleteHeartbeat = controller.indexOf(
    "delete that exact heartbeat",
    terminalBoundary,
  );
  const stopPrimary = controller.indexOf("stop the current Milestone's Primary branch", deleteHeartbeat);
  const loadNotification = controller.indexOf(
    "$codex-small-loop:sending-user-notifications",
    stopPrimary,
  );
  const presentResult = controller.indexOf(
    "present the completion outcome",
    loadNotification,
  );
  assert.ok(
    terminalBoundary >= 0 &&
      terminalBoundary < deleteHeartbeat &&
      deleteHeartbeat < stopPrimary &&
      stopPrimary < loadNotification &&
      loadNotification < presentResult,
  );
  const specTerminal = controllerSpec.indexOf("At verified completion or unrecoverable stop");
  const specRemove = controllerSpec.indexOf("removes monitoring", specTerminal);
  const specStop = controllerSpec.indexOf("stops the Primary", specRemove);
  const specNotify = controllerSpec.indexOf("notifies the user", specStop);
  const specDelivery = controllerSpec.indexOf("completion evidence or stop", specNotify);
  assert.ok(
    specTerminal >= 0 &&
      specTerminal < specRemove &&
      specRemove < specStop &&
      specStop < specNotify &&
      specNotify < specDelivery,
  );
});

test("current project Works form an Overview-rooted graph", async () => {
  const map = spawnSync(
    process.execPath,
    [
      path.join(
        repositoryRoot,
        "implementation/components/commands/sonner.mjs",
      ),
      "--project-root",
      repositoryRoot,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(map.status, 0, map.stderr);
  const sonner = JSON.parse(map.stdout);
  assert.equal(sonner.version, 11);
  assert.equal(sonner.workGraph.status, "valid");
  const works = sonner.workGraph.works;
  assert.equal(works.filter((work) => work.type === "Overview").length, 1);
  assert.deepEqual(
    works.map(({ id, nodePath }) => ({ id, nodePath })),
    [
      { id: "overview", nodePath: "overview/.WORK_NODE.xml" },
      {
        id: "product-concept",
        nodePath: "product-concept/.WORK_NODE.xml",
      },
      {
        id: "interaction-specification",
        nodePath: "specification/interaction-specification/.WORK_NODE.xml",
      },
      {
        id: "system-specification",
        nodePath: "specification/system-specification/.WORK_NODE.xml",
      },
      {
        id: "technical-specification",
        nodePath: "specification/technical-specification/.WORK_NODE.xml",
      },
      {
        id: "implementation",
        nodePath: "implementation/.WORK_NODE.xml",
      },
      {
        id: "user-documentation",
        nodePath: "user-documentation/.WORK_NODE.xml",
      },
    ],
  );

  assert.equal(await exists("docs"), false);

  const overviewNode = await read("overview/.WORK_NODE.xml");
  assert.match(overviewNode, /<work-node id="overview" type="Overview">/);
  assert.match(overviewNode, /<summary>[^<]+<\/summary>/);
  assert.match(overviewNode, /<inputs\s*\/>/);
  assert.equal(await exists(".WORK_NODE.xml"), false);
  assert.equal(await exists("works"), false);

  const implementationNode = await read("implementation/.WORK_NODE.xml");
  assert.match(implementationNode, /<work-node id="implementation" type="Implementation">/);
  assert.match(implementationNode, /<summary>[^<]*seven Skills[^<]*Sonner project inspection[^<]*<\/summary>/);
  assert.doesNotMatch(implementationNode, /Work mapper/i);
  assert.match(implementationNode, /<input ref="interaction-specification"\s*\/>/);
  assert.match(implementationNode, /<input ref="system-specification"\s*\/>/);
  assert.match(implementationNode, /<input ref="technical-specification"\s*\/>/);

  const systemNode = await read("specification/system-specification/.WORK_NODE.xml");
  assert.match(systemNode, /<summary>[^<]*five job roles[^<]*seven skills[^<]*<\/summary>/i);
  assert.doesNotMatch(systemNode, /eight skills/i);

  const implementationEntries = await readdir(
    path.join(repositoryRoot, "implementation"),
  );
  assert.deepEqual(implementationEntries.sort(), [
    ".WORK_NODE.xml",
    ".codex-plugin",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "assets",
    "components",
    "contents",
    "skills",
    "testing",
    "testing.md",
    "third_party",
  ]);
  assert.equal(await read("implementation/LICENSE"), await read("LICENSE"));

  const repositoryStructure = await read(
    "specification/technical-specification/package/repository-structure.md",
  );
  assert.match(repositoryStructure, /^---\nsummary:/);
  assert.match(repositoryStructure, /plugin/i);
  assert.match(repositoryStructure, /skills\/\s+# Complete six-Skill specification inventory/);
  assert.doesNotMatch(repositoryStructure, /seven-Skill specification inventory/i);

  const testing = await read(
    "implementation/testing.md",
  );
  assert.match(testing, /^---\nsummary:/);
  assert.match(testing, /Do not build automated E2E tests/i);
  assert.match(testing, /each part can be tested independently/i);
  assert.match(testing, /final end-to-end check manually/i);

  const deliveryLoop = await read(
    "specification/system-specification/coordination/managed-delivery-loop.md",
  );
  assert.match(deliveryLoop, /^---\nsummary:/);
  assert.match(deliveryLoop, /job role/i);
  assert.match(deliveryLoop, /fresh Execute owns each Milestone/i);
  assert.match(deliveryLoop, /four Review\s+responsibilities/i);

  const authority = await read(
    "product-concept/authority-gated-autonomy.md",
  );
  assert.match(authority, /^---\nsummary:/);
  assert.match(authority, /authority-gated autonomy/i);

  const taskAutomation = await read(
    "specification/system-specification/coordination/task-coordination.md",
  );
  assert.match(taskAutomation, /^---\nsummary:/);
  assert.match(taskAutomation, /Task Coordination/i);
  assert.match(taskAutomation, /managed Task/i);
  assert.match(taskAutomation, /Conversation/i);
  assert.match(taskAutomation, /active state, not permanent project history/i);
  assert.match(taskAutomation, /active work rather than.*task ever created/is);
  assert.match(taskAutomation, /Technical Specification/i);
  assert.doesNotMatch(taskAutomation, /Codex JSON-RPC|one-minute heartbeat/i);

  const interactionEntries = await readdir(
    path.join(repositoryRoot, "specification/interaction-specification"),
    { withFileTypes: true },
  );
  const interactionNames = interactionEntries.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : entry.name,
  );
  assert.deepEqual(interactionNames.sort(), [
    ".WORK_NODE.xml",
    "activation/",
    "agreement/",
    "delivery/",
  ]);

  const systemEntries = await readdir(
    path.join(repositoryRoot, "specification/system-specification"),
    { withFileTypes: true },
  );
  const systemNames = systemEntries.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : entry.name,
  );
  assert.deepEqual(systemNames.sort(), [
    ".WORK_NODE.xml",
    "coordination/",
    "roles/",
    "skills/",
    "work-graph/",
  ]);

  const runtimeContractEntries = await readdir(
    path.join(repositoryRoot, "specification/technical-specification"),
    { withFileTypes: true },
  );
  const runtimeContractNames = runtimeContractEntries.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : entry.name,
  );
  assert.deepEqual(runtimeContractNames.sort(), [
    ".WORK_NODE.xml",
    "integrations/",
    "package/",
    "runtime/",
  ]);

  const runtimeEntries = await readdir(
    path.join(repositoryRoot, "specification/technical-specification/runtime"),
    { withFileTypes: true },
  );
  const runtimeNames = runtimeEntries.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : entry.name,
  );
  assert.deepEqual(runtimeNames.sort(), [
    "conversations.md",
    "desktop-host-and-transport.md",
    "lifecycle-and-recovery.md",
    "local-board.md",
    "project-runtime.md",
    "review-snapshots-and-signals.md",
    "role-loading.md",
    "task-coordination.md",
  ]);

  const roleSpecs = (await readdir(
    path.join(repositoryRoot, "specification/system-specification/roles"),
  )).sort();
  const roleImplementations = (await readdir(
    path.join(repositoryRoot, "implementation/components/roles"),
  )).sort();
  assert.deepEqual(roleSpecs, roleImplementations.map((name) => `${name}.md`));

  const skillSpecs = (await readdir(
    path.join(repositoryRoot, "specification/system-specification/skills"),
  )).sort();
  const skillImplementations = (await readdir(
    path.join(repositoryRoot, "implementation/skills"),
  )).sort();
  assert.deepEqual(skillSpecs, skillImplementations.map((name) => `${name}.md`));

  assert.equal(
    await exists("implementation/components/commands/task.mjs"),
    true,
  );
  assert.equal(
    await exists("implementation/components/commands/conversation.mjs"),
    true,
  );
  assert.equal(
    await exists("implementation/components/commands/message.mjs"),
    true,
  );
  assert.equal(
    await exists("implementation/components/runtime/source/review-snapshot.mjs"),
    true,
  );
});

test("repository Works and the installable plugin share the production structure", async () => {
  assert.equal(await exists(".WORK_NODE.xml"), false);
  assert.equal(await exists("works"), false);
  assert.equal(await exists("overview/.WORK_NODE.xml"), true);
  assert.equal(await exists("product-concept/.WORK_NODE.xml"), true);
  assert.equal(await exists("specification/interaction-specification/.WORK_NODE.xml"), true);
  assert.equal(await exists("specification/system-specification/.WORK_NODE.xml"), true);
  assert.equal(await exists("specification/technical-specification/.WORK_NODE.xml"), true);
  assert.equal(await exists("implementation/.WORK_NODE.xml"), true);
  assert.equal(await exists("user-documentation/.WORK_NODE.xml"), true);
  assert.equal(await exists("implementation/.codex-plugin/plugin.json"), true);
  assert.equal(await exists("implementation/skills"), true);
  assert.equal(await exists("implementation/components"), true);
});

test("runtime capability references match the current implementation boundaries", async () => {
  const ledger = await read(
    "specification/technical-specification/runtime/project-runtime.md",
  );
  const lifecycle = await read(
    "specification/technical-specification/runtime/lifecycle-and-recovery.md",
  );
  const coordination = await read(
    "specification/technical-specification/runtime/task-coordination.md",
  );
  const conversations = await read(
    "specification/technical-specification/runtime/conversations.md",
  );
  const runtime = await read(
    "specification/technical-specification/runtime/project-runtime.md",
  );
  const desktopHost = await read(
    "specification/technical-specification/runtime/desktop-host-and-transport.md",
  );
  const supervisor = await read(
    "specification/technical-specification/runtime/lifecycle-and-recovery.md",
  );
  const signals = await read(
    "specification/technical-specification/runtime/review-snapshots-and-signals.md",
  );

  assert.match(ledger, /schema version 10/i);
  assert.match(ledger, /no migration path from earlier prototype ledgers/i);
  assert.match(ledger, /LEDGER_VERSION_UNSUPPORTED/i);
  assert.match(ledger, /pending launches/i);
  assert.match(ledger, /AtomicJsonStore/i);
  assert.doesNotMatch(ledger, /source\/automation\.mjs/i);

  assert.match(runtime, /There is no explicit `setup` command/i);
  assert.match(runtime, /recovery-supervisor-error\.json/i);
  assert.match(runtime, /readiness:\s*"repair_required"/i);
  assert.match(runtime, /partial.*events|events.*partial/is);
  assert.match(runtime, /does not erase a Supervisor failure diagnostic/i);
  assert.match(supervisor, /lock.*process is proven absent/is);
  assert.match(supervisor, /bounded exponential backoff/i);
  assert.match(supervisor, /partial.*diagnostic|diagnostic.*partial/is);
  assert.match(lifecycle, /active Conversation branch/i);
  assert.match(lifecycle, /task-state-observer\.mjs/i);
  assert.match(coordination, /task-launch\.mjs/i);
  assert.match(coordination, /task-forest\.mjs/i);
  assert.match(conversations, /conversation\.mjs.*Agent-facing route/is);
  assert.match(conversations, /message\.mjs.*one-way Notification/is);
  assert.match(desktopHost, /LaunchServices/i);
  assert.match(desktopHost, /com\.openai\.codex/i);
  assert.match(desktopHost, /independent\s+of caller process ancestry/i);
  assert.match(desktopHost, /codex-app-server-host\.mjs/i);
  assert.match(signals, /signal\.mjs create/);
  assert.match(signals, /signal\.mjs set-severity/);
  assert.match(signals, /signal\.mjs list/);
  assert.match(signals, /Implementation Approach/i);
  assert.match(signals, /\.codex-small-loop\/signals\/<primary-task-id>\/<currentSnapshot>/);
  assert.match(signals, /One material finding produces one file/is);
  assert.match(signals, /required[\s\S]*consider[\s\S]*later[\s\S]*dismiss/i);
  assert.match(signals, /template[\s\S]*severity[\s\S]*summary/i);
  assert.doesNotMatch(signals, /signal\.mjs decide|decision sidecar/i);
  assert.match(signals, /SIGNAL_INVALID_RECORDS/);
  assert.match(signals, /fails.*SIGNAL_LEGACY_ISSUES_PRESENT/is);
});

test("public task flow replaces the first-task-only page", async () => {
  assert.equal(
    await exists(
      "user-documentation/start-first-task.md",
    ),
    false,
  );
  assert.equal(
    await exists(
      "user-documentation/run-a-task.md",
    ),
    true,
  );

  const install = await read(
    "user-documentation/install.md",
  );
  const update = await read(
    "user-documentation/update.md",
  );
  const runTask = await read(
    "user-documentation/run-a-task.md",
  );

  assert.match(install, /Desktop.*\+|(?:\+|plus).*menu/is);
  assert.match(install, /Use Codex Small Loop to/i);
  assert.doesNotMatch(
    install,
    /begin with an ordinary request|Start With An Ordinary Request/i,
  );
  assert.match(update, /Source changes do not update an installed plugin cache/i);
  assert.match(update, /no active Codex Small Loop work depends on the installed snapshot/i);
  assert.match(update, /refresh|reinstall/i);
  assert.match(
    update,
    /codex plugin remove codex-small-loop@codex-small-loop --json/i,
  );
  assert.match(
    update,
    /codex plugin add codex-small-loop@codex-small-loop --json/i,
  );
  assert.match(update, /installedPath/);
  assert.match(update, /CSL_PLUGIN_ROOT/);
  assert.match(update, /codex plugin list --json/i);
  assert.match(update, /assets\/codex-small-loop\.svg/);
  assert.match(update, /contents\/welcome\/initialization-guide\.md/);
  assert.match(update, /contents\/welcome\/execution-profiles\.json/);
  assert.match(update, /contents\/welcome\/welcome-loop\.png/);
  assert.match(update, /installed.*enabled/is);
  assert.match(update, /new Codex conversation/i);
  assert.match(
    install,
    /first managed operation initializes the private project runtime\s+automatically/i,
  );
  assert.doesNotMatch(install, /reports exact setup or repair instructions/i);
  assert.match(install, /first Codex Small Loop turn/i);
  assert.doesNotMatch(install, /codex-small-loop-doctor|Codex Small Loop Doctor/i);
  assert.doesNotMatch(install, /\$CodexSmallLoopDoctor/i);
  assert.match(install, /creates the private local\s+runtime\s+automatically/i);
  assert.match(
    install,
    /No Runtime\s+Task, project-wide Codex Automation, or user setup step is required/i,
  );
  assert.match(install, /codex plugin marketplace add/i);
  assert.match(install, /codex plugin add/i);
  assert.doesNotMatch(install, /gh skill|GitHub CLI/i);
  assert.match(
    install,
    /\[Run a Task]\(\/user-documentation\/run-a-task\.md\)/,
  );
  assert.match(install, /Obsidian is not required/i);
  assert.doesNotMatch(install, /\.obsidian/i);
  assert.match(install, /without\s+inspecting project state/i);
  assert.match(install, /repository root.*vault root/is);
  assert.match(install, /Slack/i);
  assert.match(install, /required/i);
  assert.match(install, /reminder/i);
  assert.match(runTask, /^---\nsummary:/);
  assert.match(runTask, /interview/i);
  assert.match(runTask, /plan/i);
  assert.match(runTask, /agreement|agree/i);
  assert.match(runTask, /continue|keeps? working/i);
  assert.match(runTask, /unrecoverable/i);
  assert.match(runTask, /notification|reminder/i);
  assert.match(runTask, /When Slack is connected/i);
  assert.doesNotMatch(runTask, /Codex Small Loop sends a\s+Slack reminder/i);
});

test("plugin entry points explicitly invoke Codex Small Loop from the composer", async () => {
  const plugin = JSON.parse(await read("implementation/.codex-plugin/plugin.json"));
  const readme = await read("README.md");
  const prompts = Array.isArray(plugin.interface.defaultPrompt)
    ? plugin.interface.defaultPrompt
    : [plugin.interface.defaultPrompt];
  assert.match(readme, /codex plugin marketplace add/i);
  assert.match(readme, /codex plugin add codex-small-loop@codex-small-loop/i);
  assert.match(readme, /Codex Desktop/i);
  assert.match(readme, /Installation[\s\S]*Run a Task/i);

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /components\/commands\/role\.mjs|SKILL\.md/);
  assert.match(prompts[0], /request/i);
  assert.match(plugin.interface.capabilities.join(" "), /Interactive/);
  assert.match(plugin.interface.composerIcon, /^\.\/assets\/.+/);
  assert.match(plugin.interface.logo, /^\.\/assets\/.+/);
  assert.equal(
    await exists(path.posix.join(
      "implementation",
      plugin.interface.composerIcon.replace(/^\.\//, ""),
    )),
    true,
  );
  assert.equal(
    await exists(path.posix.join(
      "implementation",
      plugin.interface.logo.replace(/^\.\//, ""),
    )),
    true,
  );
  const entryMetadata = await read(
    "implementation/skills/handling-user-requests/agents/openai.yaml",
  );
  assert.match(entryMetadata, /display_name:\s*"codex-small-loop:handling-user-requests"/);
  assert.match(entryMetadata, /allow_implicit_invocation:\s*true/);
  assert.doesNotMatch(readme, /one agent responsible for an outcome/i);
});

test("skill UI identifiers and invocations use the plugin namespace", async () => {
  const skillEntries = await readdir(
    path.join(repositoryRoot, "implementation", "skills"),
    { withFileTypes: true },
  );
  const implicitlyInvokableSkills = [];
  const visibleSkillNames = new Set(["handling-user-requests"]);

  for (const entry of skillEntries.filter((item) => item.isDirectory())) {
    const metadata = await read(
      `implementation/skills/${entry.name}/agents/openai.yaml`,
    );

    assert.match(
      metadata,
      new RegExp(`display_name:\\s*"codex-small-loop:${entry.name}"`, "i"),
    );
    assert.match(
      metadata,
      new RegExp(`\\$codex-small-loop:${entry.name}\\b`, "i"),
    );
    if (/allow_implicit_invocation:\s*true/i.test(metadata)) {
      implicitlyInvokableSkills.push(entry.name);
    }
    assert.match(
      metadata,
      new RegExp(
        `allow_implicit_invocation:\\s*${visibleSkillNames.has(entry.name) ? "true" : "false"}`,
        "i",
      ),
    );
  }
  assert.deepEqual(
    implicitlyInvokableSkills.sort(),
    ["handling-user-requests"],
  );

  const handling = await read("implementation/skills/handling-user-requests/SKILL.md");
  const controller = await read(
    "implementation/components/roles/controller/role.md",
  );
  const primary = await read(
    "implementation/components/roles/primary/role.md",
  );
  const understanding = await read(
    "implementation/skills/understanding-works/SKILL.md",
  );
  const creating = await read(
    "implementation/skills/creating-and-maintaining-works/SKILL.md",
  );
  const install = await read(
    "user-documentation/install.md",
  );
  const taskLifecycle = await read(
    "specification/technical-specification/runtime/lifecycle-and-recovery.md",
  );
  const taskMessaging = await read(
    "implementation/components/runtime/source/task-messaging.mjs",
  );
  const taskLaunch = await read(
    "specification/technical-specification/runtime/task-coordination.md",
  );

  assert.match(
    controller,
    /`\$codex-small-loop:working-with-codex-tasks`/,
  );
  assert.match(
    controller,
    /`\$codex-small-loop:interview-me`/,
  );
  assert.match(
    controller,
    /`\$codex-small-loop:sending-user-notifications`/,
  );
  assert.doesNotMatch(primary, /sending-user-notifications/);
  assert.match(
    primary,
    /`\$codex-small-loop:working-with-codex-tasks`/,
  );
  assert.match(
    understanding,
    /`\$codex-small-loop:creating-and-maintaining-works`/,
  );
  assert.match(creating, /`\$codex-small-loop:understanding-works`/);
  assert.match(
    taskLifecycle,
    /stop` and `task\.mjs resume`[\s\S]*active `awaiting_reply` Conversations/i,
  );
  assert.match(
    taskMessaging,
    /components\/commands\/role\.mjs \$\{role\}/,
  );
  assert.match(
    taskLaunch,
    /components\/commands\/role\.mjs <job-role>/,
  );

  const actionableSources = [
    handling,
    primary,
    understanding,
    creating,
    install,
    taskLifecycle,
    taskMessaging,
    taskLaunch,
  ];
  assert.ok(actionableSources.includes(install));
  assert.ok(actionableSources.includes(taskLifecycle));
  const plainExplicitOnlyHelper =
    /\\?`codex-small-loop:(?:working-with-codex-tasks|creating-and-maintaining-works|interview-me|sending-user-notifications|understanding-works)\\?`/;
  for (const source of actionableSources) {
    assert.doesNotMatch(source, plainExplicitOnlyHelper);
  }
});

test("plugin marketplace installs the Implementation Work", async () => {
  const marketplace = JSON.parse(
    await read(".agents/plugins/marketplace.json"),
  );
  const entry = marketplace.plugins.find(
    (plugin) => plugin.name === "codex-small-loop",
  );

  assert.equal(marketplace.name, "codex-small-loop");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./implementation");
  assert.equal(Object.hasOwn(entry, "version"), false);
  assert.equal(entry.policy.installation, "AVAILABLE");
});

test("Obsidian vault state stays outside version control", async () => {
  const gitignore = await read(".gitignore");

  assert.match(gitignore, /^\.obsidian\/$/m);
});

test("host-constrained skills remain at the Implementation plugin root", async () => {
  const skillEntries = await readdir(
    path.join(repositoryRoot, "implementation", "skills"),
    { withFileTypes: true },
  );
  const skillNames = skillEntries
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
  assert.deepEqual(skillNames, [
    "creating-and-maintaining-works",
    "handling-user-requests",
    "interview-me",
    "recover-unavailable-thread-schedules",
    "sending-user-notifications",
    "understanding-works",
    "working-with-codex-tasks",
  ]);

  for (const entry of skillEntries.filter((item) => item.isDirectory())) {
    const contents = await readdir(
      path.join(repositoryRoot, "implementation", "skills", entry.name),
    );
    const expected = [
      "creating-and-maintaining-works",
      "understanding-works",
    ].includes(entry.name)
      ? ["SKILL.md", "agents", "references"]
      : ["SKILL.md", "agents"];
    assert.deepEqual(contents.sort(), expected);
  }

  assert.equal(
    await exists(
      "implementation/components/commands/work-map.mjs",
    ),
    false,
  );
  assert.equal(await exists("implementation/components/work-map"), false);
  assert.equal(
    await exists(
      "implementation/components/commands/sonner.mjs",
    ),
    true,
  );
  assert.equal(
    await exists(
      "implementation/components/commands/task.mjs",
    ),
    true,
  );
  assert.equal(
    await exists(
      "implementation/components/commands/snapshot.mjs",
    ),
    true,
  );
  assert.equal(
    await exists(
      "implementation/components/commands/issue.mjs",
    ),
    false,
  );
  assert.equal(
    await exists(
      "implementation/components/commands/signal.mjs",
    ),
    true,
  );
  assert.equal(
    await exists("implementation/skills/understanding-works/scripts/work-map.mjs"),
    false,
  );
  assert.equal(
    await exists(
      "implementation/skills/understanding-works/references/work-graph.md",
    ),
    true,
  );
  assert.deepEqual(
    (await readdir(
      path.join(
        repositoryRoot,
        "implementation",
        "skills",
        "understanding-works",
        "references",
      ),
    )).sort(),
    ["work-graph.md"],
  );
  assert.deepEqual(
    (await readdir(
      path.join(
        repositoryRoot,
        "implementation",
        "skills",
        "creating-and-maintaining-works",
        "references",
      ),
    )).sort(),
    ["atomic-documentation.md"],
  );
  assert.equal(
    await exists("implementation/skills/creating-and-maintaining-works/scripts"),
    false,
  );
  assert.equal(await exists("implementation/skills/reading-docs"), false);
  assert.equal(await exists("implementation/skills/writing-docs"), false);
  assert.equal(await exists("roles"), false);
  assert.equal(await exists("scripts"), false);
  assert.equal(await exists("tests"), false);
});

test("Activity packages its executable universal macOS Signal reader", async () => {
  const helper = path.join(repositoryRoot, "implementation/components/board/native/activity-signal-reader");
  for (const packaged of [
    "implementation/components/board/native/activity-signal-reader",
    "implementation/components/board/native/activity-signal-reader.c",
    "implementation/components/board/source/activity-signal-reader.mjs",
    "implementation/components/board/source/activity-signal-reader-portable.mjs",
    "implementation/components/board/tests/activity-signal-reader-portable.test.mjs",
    "implementation/components/board/native/BUILD.md",
  ]) assert.equal(await exists(packaged), true, packaged);
  assert.equal((await stat(helper)).isFile(), true);
  const source = await read("implementation/components/board/native/activity-signal-reader.c");
  const wrapper = await read("implementation/components/board/source/activity-signal-reader.mjs");
  const portable = await read("implementation/components/board/source/activity-signal-reader-portable.mjs");
  const provenance = await read("implementation/components/board/native/BUILD.md");
  assert.match(source, /PROTOCOL_VERSION 2/);
  assert.match(source, /F_DUPFD_CLOEXEC/);
  assert.match(source, /MAX_SNAPSHOT_ENTRIES MAX_SIGNALS/);
  assert.match(source, /MAX_SIGNAL_ENTRIES MAX_SIGNALS/);
  assert.match(source, /previous_hyphen/);
  assert.doesNotMatch(source, /open\(request->root/);
  assert.match(wrapper, /DARWIN_O_NOFOLLOW_ANY/);
  assert.match(wrapper, /isValidActivitySignalName/);
  assert.match(wrapper, /stdio:[\s\S]*rootHandle\.fd/);
  assert.match(wrapper, /platform === "win32"[\s\S]*readPortableActivitySignals/);
  assert.match(portable, /O_NOFOLLOW/);
  assert.match(portable, /revalidateDirectories/);
  const digest = createHash("sha256").update(await readFile(helper)).digest("hex");
  assert.match(provenance, new RegExp(digest));
});

test("Board packages its identity-bound Sonner file opener", async () => {
  const helper = path.join(repositoryRoot, "implementation/components/board/native/sonner-open-file");
  for (const packaged of [
    "implementation/components/board/native/sonner-open-file",
    "implementation/components/board/native/sonner-open-file.c",
    "implementation/components/board/source/sonner-open-file.mjs",
    "implementation/components/board/native/BUILD.md",
  ]) assert.equal(await exists(packaged), true, packaged);
  const source = await read("implementation/components/board/native/sonner-open-file.c");
  const wrapper = await read("implementation/components/board/source/sonner-open-file.mjs");
  const provenance = await read("implementation/components/board/native/BUILD.md");
  assert.match(source, /CFURLCreateFileReferenceURL/);
  assert.match(source, /CFURLIsFileReferenceURL/);
  assert.match(source, /LSOpenCFURLRef\(reference/);
  assert.match(source, /openat\(/);
  assert.match(source, /AT_SYMLINK_NOFOLLOW/);
  assert.doesNotMatch(source, /\/usr\/bin\/open/);
  assert.match(wrapper, /openVerifiedProjectRoot/);
  assert.match(wrapper, /stdio:[\s\S]*rootHandle\.fd/);
  const digest = createHash("sha256").update(await readFile(helper)).digest("hex");
  assert.match(provenance, new RegExp(digest));
});

test("Sonner packages its descriptor-anchored project reader", async () => {
  const helper = path.join(repositoryRoot, "implementation/components/sonner/native/sonner-project-reader");
  const manifest = JSON.parse(await read("implementation/.codex-plugin/plugin.json"));
  const marketplace = JSON.parse(await read(".agents/plugins/marketplace.json"));
  assert.match(manifest.version, /^0\.1\.0\+codex\.\d{14}$/);
  assert.equal(manifest.license, "MIT");
  const versionOccurrences = [];
  for (const relative of await listRepositoryFiles()) {
    const matches = (await readFile(path.join(repositoryRoot, relative)))
      .toString("utf8")
      .match(/0\.1\.0\+codex\.\d{14}/g);
    for (const match of matches ?? []) versionOccurrences.push({ relative, match });
  }
  assert.deepEqual(versionOccurrences, [{
    relative: "implementation/.codex-plugin/plugin.json",
    match: manifest.version,
  }]);
  const marketplacePlugin = marketplace.plugins.find((plugin) => plugin.name === manifest.name);
  assert.equal(marketplacePlugin?.source?.path, "./implementation");
  assert.equal(Object.hasOwn(marketplacePlugin, "version"), false);
  for (const packaged of [
    "implementation/components/sonner/native/sonner-project-reader",
    "implementation/components/sonner/native/sonner-project-reader.c",
    "implementation/components/sonner/native/BUILD.md",
    "implementation/components/sonner/source/sonner-project-reader.mjs",
    "implementation/components/sonner/source/sonner-portable-io.mjs",
    "implementation/components/sonner/tests/sonner-portable-io.test.mjs",
    "implementation/components/sonner/source/sonner.mjs",
    "implementation/components/sonner/source/sonner-text.mjs",
    "implementation/components/sonner/tests/sonner-text.test.mjs",
    "implementation/components/sonner/source/runtime.mjs",
    "implementation/components/commands/sonner.mjs",
    "implementation/components/board/public/index.html",
    "implementation/components/board/public/app.js",
    "implementation/components/board/public/styles.css",
    "implementation/components/board/public/sonner-view.js",
    "implementation/components/board/public/vendor/elk.bundled.js",
  ]) assert.equal(await exists(packaged), true, packaged);
  assert.equal((await stat(helper)).isFile(), true);
  const source = await read("implementation/components/sonner/native/sonner-project-reader.c");
  const wrapper = await read("implementation/components/sonner/source/sonner-project-reader.mjs");
  const portable = await read("implementation/components/sonner/source/sonner-portable-io.mjs");
  const projection = await read("implementation/components/sonner/source/sonner.mjs");
  const textFormatter = await read("implementation/components/sonner/source/sonner-text.mjs");
  const testing = await read("implementation/testing.md");
  const command = await read("implementation/components/commands/sonner.mjs");
  const view = await read("implementation/components/board/public/sonner-view.js");
  const provenance = await read("implementation/components/sonner/native/BUILD.md");
  assert.match(source, /PROTOCOL_VERSION 3/);
  assert.match(source, /openat\(/);
  assert.match(source, /AT_SYMLINK_NOFOLLOW/);
  assert.match(source, /F_DUPFD_CLOEXEC/);
  assert.doesNotMatch(source, /open\(request->/);
  assert.match(wrapper, /DARWIN_O_NOFOLLOW_ANY/);
  assert.match(wrapper, /stdio:[\s\S]*rootHandle\.fd/);
  assert.match(wrapper, /platform === "win32"[\s\S]*readPortableSonnerProject/);
  assert.match(portable, /execFileAsync\("git"/);
  assert.match(portable, /shell:\s*false/);
  assert.match(portable, /revalidateAncestors/);
  assert.doesNotMatch(portable, /\.\.\.environment/);
  assert.match(projection, /SONNER_SCHEMA_VERSION = 11/);
  assert.match(projection, /version: SONNER_SCHEMA_VERSION,[\s\S]*workGraph:[\s\S]*files:[\s\S]*runtime,/);
  assert.match(projection, /outputs:/);
  assert.match(projection, /options\.json \? serializeSonner\(projection\) : formatSonnerText\(projection\)/);
  assert.match(textFormatter, /Sonner v\$\{value\.version\}/);
  assert.match(textFormatter, /values\.join\(", "\)/);
  assert.match(textFormatter, /Tasks: empty/);
  assert.match(textFormatter, /Unicode 16\.0 unsafe-display union/);
  assert.match(textFormatter, /DerivedGeneralCategory\.txt/);
  assert.match(textFormatter, /DerivedCoreProperties\.txt/);
  assert.match(textFormatter, /PropList\.txt/);
  assert.match(testing, /pinned Unicode 16\.0 unsafe-display boundary/);
  assert.match(command, /runSonnerCli/);
  assert.match(view, /globalThis\.ELK/);
  assert.match(view, /export async function layoutWorkGraph/);
  const digest = createHash("sha256").update(await readFile(helper)).digest("hex");
  assert.match(provenance, new RegExp(digest));
});

test("Sonner packages descriptor-anchored Runtime and history readers", async () => {
  const provenance = await read("implementation/components/sonner/native/BUILD.md");
  for (const packaged of [
    "implementation/components/sonner/native/sonner-safe-io.c",
    "implementation/components/sonner/native/sonner-safe-io.h",
    "implementation/components/sonner/native/sonner-runtime-reader",
    "implementation/components/sonner/native/sonner-runtime-reader.c",
    "implementation/components/sonner/native/sonner-task-history-reader",
    "implementation/components/sonner/native/sonner-task-history-reader.c",
    "implementation/components/sonner/source/sonner-runtime-reader.mjs",
    "implementation/components/sonner/source/sonner-task-history-reader.mjs",
    "implementation/components/sonner/source/sonner-portable-io.mjs",
  ]) assert.equal(await exists(packaged), true, packaged);
  for (const relative of [
    "implementation/components/sonner/native/sonner-runtime-reader",
    "implementation/components/sonner/native/sonner-task-history-reader",
  ]) {
    const helper = path.join(repositoryRoot, relative);
    const digest = createHash("sha256").update(await readFile(helper)).digest("hex");
    assert.match(provenance, new RegExp(digest));
  }
  const runtimeSource = await read("implementation/components/sonner/native/sonner-runtime-reader.c");
  const historySource = await read("implementation/components/sonner/native/sonner-task-history-reader.c");
  const runtimeWrapper = await read("implementation/components/sonner/source/sonner-runtime-reader.mjs");
  const historyWrapper = await read("implementation/components/sonner/source/sonner-task-history-reader.mjs");
  const projectWrapper = await read("implementation/components/sonner/source/sonner-project-reader.mjs");
  const projection = await read("implementation/components/sonner/source/sonner.mjs");
  const runtimeProjection = await read("implementation/components/sonner/source/runtime.mjs");
  assert.match(runtimeSource, /sonner_safe_adopt_root/);
  assert.match(runtimeSource, /sonner_safe_read_fixed/);
  assert.match(historySource, /sonner_safe_adopt_root/);
  assert.match(historySource, /sonner_safe_read_tail/);
  assert.match(historySource, /MAX_TAIL \(2U \* 1024U \* 1024U\)/);
  assert.match(historySource, /openat\(/);
  assert.match(historySource, /AT_SYMLINK_NOFOLLOW/);
  assert.match(runtimeWrapper, /session\.rootHandle\.fd/);
  assert.match(historyWrapper, /stdio:[\s\S]*handle\.fd/);
  assert.match(historyWrapper, /SONNER_HISTORY_PROTOCOL_VERSION = 2/);
  assert.match(historyWrapper, /current\.truncated && reduced\.turnState === "not_started"/);
  assert.match(projectWrapper, /new AbortController\(\)/);
  assert.match(projectWrapper, /remainingMs\(\)/);
  assert.match(projection, /Promise\.allSettled\(branches\)/);
  assert.match(projection, /session\.abort\(error\)/);
  assert.doesNotMatch(historyWrapper, /roots\s*=\s*await Promise\.all/);
  assert.match(historyWrapper, /for \(let index = 0; index < rootsConfig\.length; index \+= 1\)/);
  assert.match(runtimeProjection, /Promise\.allSettled\(\[observation, diagnostic\]\)/);
  assert.match(runtimeProjection, /session: options\.projectSession/);
  assert.doesNotMatch(`${runtimeWrapper}\n${historyWrapper}`, /\b(?:clang|cc|xcrun)\b|spawnSync/);
  assert.doesNotMatch(runtimeSource, /stateFile|projectRoot/);
  assert.doesNotMatch(historySource, /CODEX_HOME|archived_sessions|\/Users\//);
});

test("Sonner closure keeps schema v11 and flat active Runtime surfaces free of retired contracts", async () => {
  const creating = await read("implementation/skills/creating-and-maintaining-works/SKILL.md");
  const lifecycleTests = await read("implementation/components/sonner/tests/sonner-lifecycle.test.mjs");
  const serverTests = await read("implementation/components/board/tests/board-server.test.mjs");
  const html = await read("implementation/components/board/public/index.html");
  const app = await read("implementation/components/board/public/app.js");
  const styles = await read("implementation/components/board/public/styles.css");

  assert.match(creating, /does not automatically load `understanding-works`, run\s+Sonner/i);
  assert.doesNotMatch(creating, /Work Graph mapper/i);
  assert.doesNotMatch(serverTests, /\bversion:\s*6\b/);
  assert.match(serverTests, /\bversion:\s*10\b/);
  assert.match(lifecycleTests, /health:\s*"unknown", reasons:\s*\["observation_failed"\], tasks:\s*\[\]/);
  assert.doesNotMatch(lifecycleTests, /health:\s*"unknown", settled:|counts:\s*\{\}, roots:/);
  assert.match(html, /id="runtime-task-list"[^>]*class="runtime-task-list"/);
  assert.match(app, /el\("runtime-task-list"\)/);
  assert.match(styles, /\.runtime-task-list\s*\{/);
  assert.doesNotMatch(`${html}\n${app}\n${styles}`, /runtime-task-tree/);
});

test("Board packages one detached shared Host with project URLs and browser leases", async () => {
  const host = await read("implementation/components/board/source/board-host.mjs");
  const hostServer = await read("implementation/components/board/source/board-host-server.mjs");
  const server = await read("implementation/components/board/server.mjs");
  const app = await read("implementation/components/board/public/app.js");
  assert.match(host, /detached: true, stdio: "ignore", shell: false/);
  assert.match(host, /child\.unref\(\)/);
  assert.match(host, /\?project=/);
  assert.match(hostServer, /createLeaseTracker/);
  assert.match(hostServer, /\? project : null/);
  assert.doesNotMatch(hostServer, /\? project\.root : null/);
  assert.match(server, /buildSonnerProject/);
  assert.match(server, /sonnerLoader\(selectedProject\)/);
  assert.match(server, /text\/event-stream/);
  assert.match(server, /api\/control\/stop/);
  assert.match(app, /new EventSource/);
  assert.match(app, /api\/lease/);
});

test("Activity keeps Desktop titles display-only and presents Reviews through an exclusive accessible UI", async () => {
  const titles = await read("implementation/components/board/source/activity-thread-titles.mjs");
  const data = await read("implementation/components/board/source/activity-data.mjs");
  const html = await read("implementation/components/board/public/index.html");
  const css = await read("implementation/components/board/public/styles.css");
  const app = await read("implementation/components/board/public/app.js");
  assert.match(titles, /new DatabaseSync\(file, \{ readOnly: true, allowExtension: false, timeout: ACTIVITY_THREAD_DATABASE_BUSY_TIMEOUT_MS \}\)/);
  assert.match(titles, /ACTIVITY_THREAD_DATABASE_BUSY_TIMEOUT_MS = 50/);
  assert.match(titles, /MAX_ACTIVITY_THREAD_DATABASE_BYTES = 32 \* 1024 \* 1024/);
  assert.match(titles, /--disable-warning=ExperimentalWarning/);
  assert.match(titles, /titleWorkerBarrier/);
  assert.match(titles, /primary\.length === 1.*primary\[0\]\?\.name === "id".*primary\[0\]\?\.pk === 1/);
  assert.match(titles, /pragma_index_info\(\?\).*LIMIT 2/); assert.match(titles, /WHERE id IN \(\$\{placeholders\}\) LIMIT \?/);
  assert.match(titles, /ACTIVITY_THREAD_LOOKUP_TIMEOUT_MS = 400/); assert.match(titles, /worker\.terminate/);
  assert.match(titles, /MAX_ACTIVITY_THREAD_TITLE_BYTES = 512/);
  assert.match(titles, /MAX_ACTIVITY_THREAD_TITLE_ROWS = 256/);
  assert.match(titles, /database\?\.close\(\)/);
  assert.match(data, /MAX_CONVERSATION_ACTIVITY_EVENTS = 4_096/);
  assert.match(data, /direction: "SENT"/); assert.match(data, /direction: "RECEIVED"/);
  assert.match(data, /agentsById\.get\(event\.counterpartyTaskId\)\?\.available !== false/);
  assert.match(data, /activityIds\.includes\(taskId\).*forest\.roleByTask\.get\(taskId\) === "primary"/s);
  assert.match(html, />Reviews<\/button>/); assert.match(html, /aria-label="Reviews"/);
  assert.match(css, /\.split\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /color-scheme:\s*light/); assert.match(css, /\.turn-band\s*\{[^}]*border-radius:\s*2px/);
  assert.doesNotMatch(`${css}\n${app}`, /\.mark|outside-cycle|cycleContainsTimestamp/);
  assert.match(app, /No confirmed Output is available/);
  assert.match(app, /for \(const turn of turns\)/); assert.match(app, /scrollIntoView/);
  assert.match(css, /\.activity-view\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.detail-panel\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(app, /agent\.activity \?\? agent\.records/); assert.match(app, /cycle\.endedAt \?\?/);
  assert.match(app, /textContent = signal\.raw/);
});

test("Board shell exposes Primary-root Activity terminology without legacy Board-view contracts", async () => {
  const data = await read("implementation/components/board/source/activity-data.mjs");
  const server = await read("implementation/components/board/server.mjs");
  const html = await read("implementation/components/board/public/index.html");
  const controller = await read("implementation/components/roles/controller/role.md");
  const primary = await read("implementation/components/roles/primary/role.md");

  for (const legacy of [
    "implementation/components/board/source/board-data.mjs",
    "implementation/components/board/source/board-history.mjs",
    "implementation/components/board/source/board-signal-reader.mjs",
    "implementation/components/board/source/board-thread-titles.mjs",
    "implementation/components/board/public/selection.js",
  ]) assert.equal(await exists(legacy), false, legacy);
  assert.match(server, /"\/api\/activities", "\/api\/activity", "\/api\/activity\/updates", "\/api\/sonner"/);
  assert.match(server, /ACTIVITY_REFRESH_REQUIRED/);
  assert.match(data, /MAX_ACTIVITY_LIVE_APPEND_BYTES = 2 \* 1024 \* 1024/);
  assert.match(data, /cloneActivityHistoryContinuation/);
  assert.match(data, /selectedLedgerProjection/);
  assert.match(data, /authorizedSelectedTaskIds/);
  assert.match(data, /visibleTaskIds/);
  assert.match(data, /omissionMode: "reject"/);
  assert.match(data, /isDeepStrictEqual\(detachedDetail, initialDetail\)/);
  assert.match(data, /stagedBudget\.sessionSourceBytes \+ deltaBytes/);
  assert.match(data, /for \(const \[taskId, source\] of stagedSources\)/);
  assert.doesNotMatch(server, /"\/api\/roots"|"\/api\/root"/);
  assert.match(html, /aria-label="Activity"/);
  assert.doesNotMatch(html, /aria-label="Board"/);
  assert.match(data, /parentRole === "controller" && edge\.childRole === "primary"/);
  assert.match(data, /activities\.map\(\(activity\) => \(\{ taskId: activity\.taskId, role: "primary", parentTaskId: null \}\)\)/);
  assert.doesNotMatch(data, /role: "controller", parentTaskId: null/);
  assert.match(controller, /Never reuse a Primary from an earlier Milestone/);
  assert.match(controller, /stop the completed Primary branch/);
  assert.match(primary, /reused only inside its Milestone/);
  assert.match(primary, /Never accept a\s+later-Milestone Conversation/);
});

test("Controller owns the shared Board Host ensure/open boundary", async () => {
  const controller = await read("implementation/components/roles/controller/role.md");
  const primary = await read("implementation/components/roles/primary/role.md");
  const execute = await read("implementation/components/roles/execute/role.md");
  const controllerSpec = await read(
    "specification/system-specification/roles/controller.md",
  );
  const interaction = await read(
    "specification/interaction-specification/delivery/local-board.md",
  );
  const coordination = await read(
    "specification/system-specification/coordination/local-board.md",
  );
  const lifecycle = await read(
    "specification/technical-specification/runtime/lifecycle-and-recovery.md",
  );
  const host = await read("implementation/components/board/source/board-host.mjs");
  const cli = await read("implementation/components/commands/board.mjs");
  const ensure = controller.indexOf("components/commands/board.mjs ensure");
  const browser = controller.indexOf("Codex Browser", ensure);
  const primaryFork = controller.indexOf("context-preserving `primary` fork", browser);
  assert.ok(ensure >= 0 && ensure < browser && browser < primaryFork);
  assert.match(
    controller,
    /do not (?:send|add)[\s\S]{0,80}textual[\s\S]{0,40}(?:notice|guidance)/i,
  );
  assert.doesNotMatch(controller, /tell the user\s+the\s+URL/i);
  assert.match(controller, /shared user-scoped\s+Board Host/i);
  assert.match(controller, /open Board page holds a live lease/i);
  assert.match(controller, /Do not poll or repeatedly run ensure/i);
  assert.match(controller, /fail(?:s|ure)?[\s\S]*continue.*Primary/i);
  assert.match(primary, /never opens or operates the user's Browser/i);
  assert.match(primary, /before this Primary Task is\s+created/i);
  assert.match(execute, /never opens or operates the user's Browser/i);
  for (const source of [controllerSpec, interaction, coordination, lifecycle]) {
    assert.match(source, /before[\s\S]{0,100}Primary/i);
    assert.doesNotMatch(source, /tell(?:s)? the user the URL/i);
  }
  assert.match(host, /127\.0\.0\.1/);
  assert.match(cli, /"ensure", "status", "url", "stop"/);
});

test("Work skills separate project understanding from mutation", async () => {
  const understanding = await read(
    "implementation/skills/understanding-works/SKILL.md",
  );
  const creating = await read(
    "implementation/skills/creating-and-maintaining-works/SKILL.md",
  );

  assert.match(understanding, /name:\s*understanding-works/);
  assert.match(understanding, /Use from Controller before assigning a project-change Milestone/i);
  assert.match(understanding, /Primary, Execute, Review, and Interviewer do not invoke this skill again/i);
  assert.match(understanding, /Work Graph/i);
  assert.match(understanding, /WORK_NODE\.xml/i);
  assert.match(understanding, /directory names[\s\S]*filenames[\s\S]*summar/is);
  assert.match(understanding, /explicit repository-root-relative Markdown links/i);
  assert.match(understanding, /backlinks/i);
  assert.match(understanding, /same or clearly shared descriptive name/i);
  assert.match(understanding, /components\/commands\/sonner\.mjs/);
  assert.match(understanding, /--project-root <project-root>/);
  assert.match(understanding, /`outputs` for[\s\S]*downstream impact/i);
  assert.match(understanding, /workGraph\.status[\s\S]*missing[\s\S]*invalid/i);
  assert.doesNotMatch(understanding, /--context|work-map\.mjs/i);
  assert.match(understanding, /sufficient grounding, not loading the entire project/i);

  assert.match(creating, /name:\s*creating-and-maintaining-works/);
  assert.match(creating, /creating, updating, moving, renaming, splitting, merging, or deleting project files/i);
  assert.match(creating, /does not automatically load `understanding-works`/i);
  assert.match(creating, /earliest affected Work/i);
  assert.match(creating, /Atomic Documentation/i);
  assert.match(creating, /repository-root-relative paths/i);
  assert.match(creating, /Obsidian backlinks/i);
  assert.match(creating, /align descriptive names/i);
  assert.match(creating, /material topology change/i);
  assert.match(creating, /user agreement/i);
  assert.match(creating, /does not require perfect[\s\S]*file-level traceability/i);
  assert.match(creating, /force every file into a Work/i);
  assert.match(creating, /parallel binding database/i);

  assert.equal(await exists("implementation/skills/reading-docs"), false);
  assert.equal(await exists("implementation/skills/writing-docs"), false);
});

test("Work Graph knowledge supports media-independent project grounding", async () => {
  const graph = await read(
    "implementation/skills/understanding-works/references/work-graph.md",
  );

  assert.match(graph, /^---\nsummary:/);
  assert.match(graph, /maintained production output/i);
  assert.match(graph, /exactly one `Overview`/i);
  assert.match(
    graph,
    /not a schedule, task list,[\s\S]*(?:or )?inventory of every[\s\S]*repository file/i,
  );
  assert.match(graph, /ID.*independent of the directory basename/i);
  assert.match(graph, /references only existing inputs/i);
  assert.match(graph, /contains no cycle/i);
  assert.match(graph, /smallest graph that improves production decisions/i);
  assert.match(graph, /Not every maintained file belongs to a Work/i);
  assert.match(graph, /approved current and future production structure/i);
  assert.match(graph, /Documents add precise[\s\S]*Markdown links/i);
  assert.match(graph, /aligned descriptive names/i);
  assert.match(graph, /separate binding database/i);
});

test("Atomic Documentation is designed backward from fast reading", async () => {
  const atomic = await read(
    "implementation/skills/creating-and-maintaining-works/references/atomic-documentation.md",
  );

  assert.match(atomic, /^---\nsummary:/);
  assert.match(atomic, /write-side contract for fast project grounding/i);
  assert.match(atomic, /one independently nameable knowledge responsibility/i);
  assert.match(atomic, /filename[\s\S]*and summar(?:y|ies) distinguish it/i);
  assert.match(atomic, /independent reasons to change/i);
  assert.match(atomic, /different downstream consumers/i);
  assert.match(atomic, /not the smallest possible file/i);
  assert.match(atomic, /directory structure, filenames, and summaries[\s\S]*project map/i);
  assert.match(atomic, /README, index, or directory-named document/i);
  assert.match(atomic, /duplicates that map and can become stale/i);
  assert.match(atomic, /distinct audience/i);
  assert.match(atomic, /native summaries[\s\S]*when they are natural/i);
  assert.match(atomic, /one canonical document/i);
});

test("reference docs record the detailed runtime contracts", async () => {
  const handling = await read(
    "specification/system-specification/skills/handling-user-requests.md",
  );
  const activation = await read(
    "specification/interaction-specification/activation/activation-and-execution-profile.md",
  );
  const loadingRole = await read(
    "specification/technical-specification/runtime/role-loading.md",
  );
  const primary = await read(
    "specification/system-specification/roles/primary.md",
  );
  const handlingRole = await read(
    "specification/system-specification/roles/controller.md",
  );
  const messageRouting = await read(
    "specification/technical-specification/runtime/conversations.md",
  );
  const notifications = await read(
    "specification/system-specification/skills/sending-user-notifications.md",
  );
  const slackDelivery = await read(
    "specification/technical-specification/integrations/slack-reminder-delivery.md",
  );
  const coordination = await read(
    "specification/system-specification/skills/working-with-codex-tasks.md",
  );

  assert.match(activation, /^---\nsummary:/);
  assert.match(activation, /handling-user-requests/i);
  assert.match(activation, /Markdown guide[\s\S]*Controller Role/i);
  assert.match(activation, /no project.*investigation[\s\S]*before the guide/i);
  assert.match(handling, /^---\nsummary:/);
  assert.match(handling, /entry point/i);
  assert.match(handling, /welcome/i);
  assert.match(handling, /components\/commands\/role\.mjs controller/i);
  assert.match(handling, /Controller[\s\S]*interview/i);
  assert.match(loadingRole, /^---\nsummary:/);
  assert.match(
    loadingRole,
    /components\/roles\/(?:primary|<role>)\/role\.md/i,
  );
  assert.match(primary, /^---\nsummary:/);
  assert.match(primary, /primary trajectory/i);
  assert.match(primary, /direct parent/i);
  assert.match(primary, /Conversation Initiator evaluates each reply/i);
  assert.match(primary, /Conversation acceptance closes only that exchange/i);
  assert.match(
    primary,
    /https:\/\/github\.com\/lopopolo\/harness-engineering\/blob\/226c8d35fb6ea3ed55467753dba6dea2b5fd5778\/docs\/whole-job\/README\.md/,
  );
  assert.match(handlingRole, /^---\nsummary:/);
  assert.match(handlingRole, /Controller[\s\S]*verification/i);
  assert.match(
    handlingRole,
    /Controller does not modify project files or directly operate Primary's[\s\S]*children/is,
  );
  assert.match(messageRouting, /^---\nsummary:/);
  assert.match(messageRouting, /turn\/steer/i);
  assert.match(messageRouting, /Fail-Closed Rules/i);
  assert.match(messageRouting, /managed exchanges/i);
  assert.match(messageRouting, /appMessages/i);
  assert.match(messageRouting, /conversation\.mjs.*Agent-facing route/is);
  assert.match(messageRouting, /message\.mjs.*one-way Notification/is);
  assert.match(messageRouting, /awaiting_reply.*replied.*accepted/is);
  assert.match(messageRouting, /MESSAGE_TARGET_BUSY/);
  assert.match(messageRouting, /active obligation graph.*forest/is);
  assert.match(messageRouting, /at-least-once/i);
  assert.match(
    messageRouting,
    /acknowledge delivery after.*schedule disappears/is,
  );
  assert.match(messageRouting, /RRULE:FREQ=MINUTELY;INTERVAL=1/i);
  assert.match(messageRouting, /past\s+timestamp/i);
  assert.match(messageRouting, /codex-small-loop-message-/i);
  assert.match(messageRouting, /first 32 hexadecimal.*SHA-256/is);
  assert.match(
    messageRouting,
    /\$CODEX_HOME\/automations\/<schedule-id>\/automation\.toml/,
  );
  assert.match(messageRouting, /mode `0700`.*mode `0600`/is);
  assert.match(messageRouting, /temporary heartbeat schedule/i);
  assert.match(messageRouting, /receiver reads and deletes.*schedule read\/delete/is);
  assert.match(messageRouting, /=== Next Actions ===/);
  assert.match(messageRouting, /=== System Instructions ===/);
  assert.match(messageRouting, /SCHEDULE_READ_FAILED/);
  assert.match(messageRouting, /SCHEDULE_CONFLICT/);
  assert.match(messageRouting, /SCHEDULE_WRITE_FAILED/);
  assert.match(messageRouting, /SCHEDULE_ETAG_MISMATCH/);
  assert.match(messageRouting, /Initiator → Responder/i);
  assert.match(messageRouting, /Initiator ←\s*Responder/i);
  assert.match(messageRouting, /Interviewer → Review/i);
  assert.match(
    messageRouting,
    /Every Conversation renders its Initiator and Responder Task IDs/is,
  );
  assert.match(messageRouting, /Task\s+names, Agent\s+names, and historical\s+`Parent\|Child`\s+labels are not rendered/i);
  assert.doesNotMatch(messageRouting, /supplies the sender's explicit Agent name/i);
  assert.match(messageRouting, /32 MiB/i);
  assert.match(messageRouting, /exact Conversation ID and `conversation reply` command/is);
  assert.match(coordination, /^---\nsummary:/);
  assert.match(coordination, /working-with-codex-tasks/i);
  assert.match(coordination, /Parent[\s\S]*Task ID/i);
  assert.match(coordination, /owns Agent-facing mechanics/i);
  assert.match(
    coordination,
    /Initiator starts an exchange[\s\S]*reply[\s\S]*continues or accepts/i,
  );
  assert.doesNotMatch(coordination, /task\.mjs accept|task accept/i);
  assert.match(notifications, /^---\nsummary:/);
  assert.match(notifications, /parent/i);
  assert.match(notifications, /Controller/i);
  assert.match(notifications, /Slack/i);
  assert.match(notifications, /reminder/i);
  assert.match(notifications, /provider-specific (?:command )?contract/i);
  assert.doesNotMatch(notifications, /1 minute ago|cannot_parse/i);
  assert.doesNotMatch(notifications, /Doctor/i);
  assert.match(slackDelivery, /1 minute ago/i);
  assert.match(slackDelivery, /reminder\s+tool.*time/is);
  assert.match(slackDelivery, /fixed|literal/i);
  assert.match(slackDelivery, /past-time.*immediately/is);
  assert.match(slackDelivery, /cannot_parse/i);
  assert.equal(
    await exists("specification/system-specification/roles/job-roles.md"),
    false,
  );
});

test("authority-gated autonomy keeps work moving and escalates only authority", async () => {
  const concept = await read(
    "product-concept/authority-gated-autonomy.md",
  );

  assert.match(concept, /^---\nsummary:/);
  assert.match(concept, /authority-gated autonomy/i);
  assert.match(concept, /explicit authority/i);
  assert.match(concept, /consequential/i);
  assert.match(concept, /continue|keeps? moving/i);
  assert.match(concept, /affected action|specific action/i);
  assert.match(concept, /never self-approves|does not self-approve/i);
  assert.match(concept, /only.*authority.*requires.*response/is);
  assert.match(concept, /parent/i);
  assert.match(concept, /Controller/i);
  assert.match(concept, /user/i);
  assert.match(concept, /human-on-the-loop/i);
  assert.match(
    concept,
    /\[Sending User Notifications]\(\/specification\/system-specification\/skills\/sending-user-notifications\.md\)/,
  );
});

test("Work Graph documents expose distributed markers without Task coupling", async () => {
  const concept = await read(
    "specification/system-specification/work-graph/concept.md",
  );
  const contract = await read(
    "specification/system-specification/work-graph/contract.md",
  );

  assert.match(concept, /^---\nsummary:/);
  assert.match(concept, /WORK_NODE\.xml/i);
  assert.match(concept, /meaningful project directory/i);
  assert.match(concept, /Work ID is independent of the containing directory/i);
  assert.match(concept, /approved future Works/i);
  assert.match(concept, /does not mean.*complete|does not indicate.*completion/is);
  assert.doesNotMatch(concept, /\bTask\b/);

  assert.match(contract, /^---\nsummary:/);
  assert.match(contract, /WORK_NODE\.xml/i);
  assert.match(contract, /id.*independent of the containing directory name/is);
  assert.match(contract, /do not require README files/i);
  assert.match(contract, /project root/i);
  assert.match(contract, /does not claim[\s\S]*every maintained project[\s\S]*file to belong to a Work/i);
  assert.match(contract, /atomic[\s\S]*summaries/i);
  assert.match(contract, /backlinks/i);
  assert.match(contract, /shared names/i);
  assert.match(contract, /approved future Works/i);
  assert.match(contract, /does not[\s\S]*status/i);
  assert.doesNotMatch(contract, /\bTask\b/);
});

test("easy grounding routes Controller context to every milestone agent", async () => {
  const concept = await read(
    "product-concept/easy-grounding.md",
  );
  const understanding = await read(
    "implementation/skills/understanding-works/SKILL.md",
  );
  const creating = await read(
    "implementation/skills/creating-and-maintaining-works/SKILL.md",
  );

  assert.match(concept, /^---\nsummary:/);
  assert.match(concept, /grounding/i);
  assert.match(concept, /working model|working context/i);
  assert.match(concept, /before.*(decid|act)/is);
  assert.match(concept, /summary/i);
  assert.match(concept, /one command|single command/i);
  assert.match(concept, /sonner\.mjs/i);
  assert.match(concept, /link/i);
  assert.match(concept, /new agent|newly started agent/i);
  assert.match(concept, /accurate|correct/i);
  assert.match(concept, /Routed to Every Agent/i);
  assert.match(
    concept,
    /https:\/\/github\.com\/lopopolo\/harness-engineering\/blob\/226c8d35fb6ea3ed55467753dba6dea2b5fd5778\/docs\/just-in-time-context\/README\.md/,
  );
  assert.match(
    concept,
    /\[Understanding Works]\(\/specification\/system-specification\/skills\/understanding-works\.md\)/,
  );
  assert.match(
    concept,
    /\[Creating And Maintaining Works]\(\/specification\/system-specification\/skills\/creating-and-maintaining-works\.md\)/,
  );
  assert.match(
    concept,
    /\[Work Graph Design]\(\/specification\/system-specification\/work-graph\/contract\.md\)/,
  );

  assert.match(understanding, /ground/i);
  assert.match(understanding, /Use from Controller before assigning a project-change Milestone/i);
  assert.match(creating, /understanding-works/i);
  assert.match(creating, /Atomic Documentation/i);
});

test("documentation links use repository-root-relative Markdown paths", async () => {
  const documents = (await Promise.all([
    "overview",
    "product-concept",
    "specification",
    "user-documentation",
  ].map((directory) => listMarkdown(directory)))).flat();

  for (const document of documents) {
    const markdown = await read(document);
    assert.doesNotMatch(markdown, /\[\[[^\]]+]]/);

    for (const match of markdown.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];

      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) {
        continue;
      }

      assert.match(
        target,
        /^\//,
        `${document} should use a repository-root-relative path for ${target}`,
      );
    }
  }
});

test("every repository-root-relative documentation link resolves", async () => {
  const documents = (await Promise.all([
    "overview",
    "product-concept",
    "specification",
    "user-documentation",
  ].map((directory) => listMarkdown(directory)))).flat();
  const missing = [];

  for (const document of documents) {
    const markdown = await read(document);

    for (const match of markdown.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];

      if (!target.startsWith("/")) {
        continue;
      }

      const relativeTarget = decodeURIComponent(target.slice(1));
      if (!await exists(relativeTarget)) {
        missing.push(`${document} -> ${target}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});
