import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AtomicJsonStore } from "./atomic-json-store.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { readCodexSessionMetadata } from "./codex-jsonl.mjs";
import { assertRuntimeAvailable } from "./project-setup.mjs";
import { resolveProject } from "./project.mjs";
import { buildTaskForest } from "./task-forest.mjs";
import {
  renderForkNotification,
  renderConversationMessage,
  renderLaunchRoleInstructions,
} from "./task-messaging.mjs";
import { startConversation } from "./conversation.mjs";
import {
  observeLatestTask,
} from "./task-state-observer.mjs";
import { transactTaskLedger } from "./task-ledger.mjs";
import {
  overrideTaskRunContext,
  requireTaskRunContext,
} from "./task-run-context.mjs";

const MAX_ID_LENGTH = 512;
const MAX_ERROR_LENGTH = 1_024;
const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const RUNTIME_SCRIPT = fileURLToPath(
  new URL("../../commands/runtime.mjs", import.meta.url),
);
const NEXT_PHASE = new Map([
  ["prepared", "creating"],
  ["creating", "child_created"],
  ["child_created", "role_started"],
  ["role_started", "assignment_starting"],
  ["assignment_starting", "assignment_started"],
  ["fork_queued", "fork_creating"],
  ["fork_creating", "fork_child_created"],
  ["fork_child_created", "fork_role_started"],
  ["fork_role_started", "fork_assignment_starting"],
  ["fork_assignment_starting", "fork_assignment_started"],
]);

export class TaskLaunchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TaskLaunchError";
    this.code = code;
    Object.assign(this, details);
  }
}

function launchError(code, message, details = {}) {
  return new TaskLaunchError(code, message, details);
}

function requireState(state) {
  if (
    state === null
    || typeof state !== "object"
    || Array.isArray(state)
    || !Array.isArray(state.managedTasks)
    || !Array.isArray(state.pendingLaunches)
    || !Array.isArray(state.links)
  ) {
    throw new TypeError(
      "state must contain managedTasks, pendingLaunches, and links arrays",
    );
  }
  return state;
}

function requireId(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ID_LENGTH
    || /\s/.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded identifier`);
  }
  return value;
}

function requireRole(value) {
  if (
    typeof value !== "string"
    || value.length > 128
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  ) {
    throw new TypeError("role must be a bounded kebab-case job role");
  }
  return value;
}

function requireName(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value.trim() !== value
    || /[\r\n]/.test(value)
  ) {
    throw new TypeError("name must be one non-empty bounded line");
  }
  return value;
}

function requireAssignment(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 64 * 1_024
  ) {
    throw new TypeError(
      "assignment must be non-empty UTF-8 text of at most 64 KiB",
    );
  }
  return value;
}

function requireExecutionOverride({
  model = null,
  reasoningEffort = null,
  serviceTier = null,
}) {
  if (model === null || reasoningEffort === null) {
    if (model !== null || reasoningEffort !== null) {
      throw new TypeError(
        "model and reasoningEffort must be provided together",
      );
    }
  } else {
    model = requireId(model, "model");
    if (!REASONING_EFFORTS.has(reasoningEffort)) {
      throw new TypeError(
        "reasoningEffort must be a supported reasoning effort",
      );
    }
  }
  if (serviceTier !== null) {
    serviceTier = requireId(serviceTier, "serviceTier");
  }
  return Object.freeze({ model, reasoningEffort, serviceTier });
}

function resolveRunContext(parentSettings, executionOverride) {
  const parentContext = requireTaskRunContext(parentSettings?.runContext);
  executionOverride = requireExecutionOverride(executionOverride);
  return overrideTaskRunContext(parentContext, {
    ...(executionOverride.model === null
      ? {}
      : {
        model: executionOverride.model,
        reasoningEffort: executionOverride.reasoningEffort,
      }),
    ...(executionOverride.serviceTier === null
      ? {}
      : { serviceTier: executionOverride.serviceTier }),
  });
}

function requireTimestamp(value, label = "now") {
  if (
    typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function requireHistoryFile(value) {
  if (value !== null && (typeof value !== "string" || !path.isAbsolute(value))) {
    throw new TypeError("historyFile must be null or an absolute path");
  }
  return value;
}

function boundedMessage(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("message must be a non-empty string");
  }
  return value.length <= MAX_ERROR_LENGTH
    ? value
    : `${value.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

function compactDiagnostic(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : null;
}

function errorDiagnosticMessage(error, fallback) {
  const message = compactDiagnostic(error?.message)
    ?? compactDiagnostic(fallback)
    ?? "Launch failed";
  const details = [];
  const code = compactDiagnostic(error?.code);
  const operation = compactDiagnostic(error?.operation);
  const stderr = compactDiagnostic(error?.stderr);
  const signal = compactDiagnostic(error?.signal);

  if (code) details.push(`code=${code}`);
  if (operation) details.push(`operation=${operation}`);
  if (Number.isSafeInteger(error?.exitCode)) {
    details.push(`exitCode=${error.exitCode}`);
  }
  if (signal) details.push(`signal=${signal}`);
  if (stderr) details.push(`stderr=${stderr}`);

  const causeCode = compactDiagnostic(error?.cause?.code);
  const causeMessage = compactDiagnostic(error?.cause?.message);
  if (causeCode) details.push(`causeCode=${causeCode}`);
  if (causeMessage) details.push(`cause=${causeMessage}`);

  return details.length === 0
    ? message
    : `${message} [${details.join("; ")}]`;
}

function safeForest(links) {
  try {
    return buildTaskForest(links);
  } catch (cause) {
    throw launchError(
      "TASK_RELATIONSHIP_INVALID",
      "Task relationships would become invalid",
      { cause },
    );
  }
}

function requireParentOpen(state, parentTaskId) {
  const forest = safeForest(state.links);
  const incoming = forest.linkByChildTaskId.get(parentTaskId);
  if (incoming && incoming.lifecycle !== "open") {
    throw launchError(
      "PARENT_TASK_NOT_OPEN",
      "A stopped or accepted managed Parent Task cannot launch work",
      { parentTaskId },
    );
  }
  return forest;
}

function findLaunch(state, launchId) {
  const index = state.pendingLaunches.findIndex(({ id }) => id === launchId);
  if (index === -1) {
    throw launchError(
      "LAUNCH_NOT_FOUND",
      "The pending launch does not exist",
      { launchId },
    );
  }
  return {
    index,
    launch: state.pendingLaunches[index],
  };
}

function requirePhase(launch, expectedPhase) {
  if (launch.phase !== expectedPhase) {
    throw launchError(
      "LAUNCH_PHASE_CONFLICT",
      `Pending launch is ${launch.phase}, not ${expectedPhase}`,
      {
        launchId: launch.id,
        expectedPhase,
        actualPhase: launch.phase,
      },
    );
  }
}

function requireNondecreasingTime(launch, now) {
  if (Date.parse(now) < Date.parse(launch.updatedAt)) {
    throw launchError(
      "LAUNCH_TIME_INVALID",
      "Pending launch time cannot move backward",
      { launchId: launch.id },
    );
  }
}

function replaceLaunch(state, index, launch, result) {
  const pendingLaunches = [...state.pendingLaunches];
  pendingLaunches[index] = launch;
  return {
    state: {
      ...state,
      pendingLaunches,
    },
    result,
  };
}

function ensureChildAvailable(state, launchId, parentTaskId, childTaskId) {
  if (childTaskId === parentTaskId) {
    throw launchError(
      "TASK_RELATIONSHIP_INVALID",
      "A task cannot be its own child",
      { parentTaskId, childTaskId },
    );
  }
  if (
    state.links.some((link) => link.childTaskId === childTaskId)
    || state.pendingLaunches.some(
      (launch) => launch.id !== launchId
        && launch.childTaskId === childTaskId,
    )
  ) {
    throw launchError(
      "CHILD_TASK_CONFLICT",
      "The Child Task already belongs to another launch or parent",
      { childTaskId },
    );
  }
}

export function preparePendingLaunch(state, {
  assignment,
  launchId,
  model = null,
  name,
  parentTaskId,
  sourceTaskId = null,
  phase = "prepared",
  reasoningEffort = null,
  role,
  serviceTier = null,
  now,
}) {
  requireState(state);
  assignment = requireAssignment(assignment);
  launchId = requireId(launchId, "launchId");
  ({ model, reasoningEffort, serviceTier } = requireExecutionOverride({
    model,
    reasoningEffort,
    serviceTier,
  }));
  name = requireName(name);
  parentTaskId = requireId(parentTaskId, "parentTaskId");
  if (sourceTaskId !== null) {
    sourceTaskId = requireId(sourceTaskId, "sourceTaskId");
  }
  role = requireRole(role);
  if (phase !== "prepared" && phase !== "fork_queued") {
    throw new TypeError("phase must be prepared or fork_queued");
  }
  if (
    (phase === "fork_queued" && sourceTaskId === null)
    || (phase === "prepared" && sourceTaskId !== null)
  ) {
    throw new TypeError(
      "sourceTaskId is required only for a queued fork",
    );
  }
  now = requireTimestamp(now);
  requireParentOpen(state, parentTaskId);

  if (state.pendingLaunches.some(({ id }) => id === launchId)) {
    throw launchError(
      "LAUNCH_CONFLICT",
      "The launch ID is already present",
      { launchId },
    );
  }
  const managedNameByTaskId = new Map(
    state.managedTasks.map((task) => [task.taskId, task.name]),
  );
  if (
    state.pendingLaunches.some((launch) =>
      launch.parentTaskId === parentTaskId && launch.name === name
    )
    || state.links.some((link) =>
      link.parentTaskId === parentTaskId
      && managedNameByTaskId.get(link.childTaskId) === name
    )
  ) {
    throw launchError(
      "TASK_NAME_CONFLICT",
      "The Parent Task already has a direct Child with this name",
      { parentTaskId, name },
    );
  }

  const launch = {
    assignment,
    id: launchId,
    model,
    name,
    parentTaskId,
    ...(sourceTaskId === null ? {} : { sourceTaskId }),
    reasoningEffort,
    role,
    serviceTier,
    childTaskId: null,
    phase,
    assignmentTurnId: null,
    roleTurnId: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  return {
    state: {
      ...state,
      pendingLaunches: [...state.pendingLaunches, launch],
    },
    result: {
      launchId,
      name,
      role,
      phase,
    },
  };
}

export function advancePendingLaunch(state, {
  launchId,
  expectedPhase,
  phase,
  childTaskId,
  roleTurnId,
  assignmentTurnId,
  now,
}) {
  requireState(state);
  launchId = requireId(launchId, "launchId");
  expectedPhase = requireId(expectedPhase, "expectedPhase");
  phase = requireId(phase, "phase");
  now = requireTimestamp(now);

  const { index, launch } = findLaunch(state, launchId);
  requirePhase(launch, expectedPhase);
  requireNondecreasingTime(launch, now);
  if (NEXT_PHASE.get(expectedPhase) !== phase) {
    throw launchError(
      "LAUNCH_PHASE_INVALID",
      `Pending launch cannot move from ${expectedPhase} to ${phase}`,
      { launchId, expectedPhase, phase },
    );
  }

  let next;
  if (phase === "creating" || phase === "fork_creating") {
    if (
      childTaskId !== undefined
      || roleTurnId !== undefined
      || assignmentTurnId !== undefined
    ) {
      throw launchError(
        "LAUNCH_PHASE_INVALID",
        "creating cannot store Child Task or assignment Turn IDs",
        { launchId },
      );
    }
    next = {
      ...launch,
      phase,
      updatedAt: now,
      lastError: null,
    };
  } else if (
    phase === "child_created"
    || phase === "fork_child_created"
  ) {
    childTaskId = requireId(childTaskId, "childTaskId");
    if (roleTurnId !== undefined || assignmentTurnId !== undefined) {
      throw launchError(
        "LAUNCH_PHASE_INVALID",
        "child_created cannot store a assignment Turn ID",
        { launchId },
      );
    }
    ensureChildAvailable(
      state,
      launchId,
      launch.parentTaskId,
      childTaskId,
    );
    next = {
      ...launch,
      childTaskId,
      phase,
      updatedAt: now,
      lastError: null,
    };
  } else if (
    phase === "role_started"
    || phase === "fork_role_started"
  ) {
    roleTurnId = requireId(roleTurnId, "roleTurnId");
    if (childTaskId !== undefined || assignmentTurnId !== undefined) {
      throw launchError(
        "LAUNCH_PHASE_INVALID",
        "role_started preserves the stored Child Task ID and cannot store an assignment Turn ID",
        { launchId },
      );
    }
    next = {
      ...launch,
      roleTurnId,
      phase,
      updatedAt: now,
      lastError: null,
    };
  } else if (
    phase === "assignment_starting"
    || phase === "fork_assignment_starting"
  ) {
    if (
      childTaskId !== undefined
      || roleTurnId !== undefined
      || assignmentTurnId !== undefined
    ) {
      throw launchError(
        "LAUNCH_PHASE_INVALID",
        "assignment_starting preserves stored Task and Role Turn IDs",
        { launchId },
      );
    }
    next = {
      ...launch,
      phase,
      updatedAt: now,
      lastError: null,
    };
  } else {
    assignmentTurnId = requireId(assignmentTurnId, "assignmentTurnId");
    if (childTaskId !== undefined || roleTurnId !== undefined) {
      throw launchError(
        "LAUNCH_PHASE_INVALID",
        "assignment_started preserves the stored Child Task ID",
        { launchId },
      );
    }
    next = {
      ...launch,
      assignmentTurnId,
      phase,
      updatedAt: now,
      lastError: null,
    };
  }

  return replaceLaunch(state, index, next, {
    launchId,
    phase,
  });
}

export function recordPendingLaunchError(state, {
  launchId,
  expectedPhase,
  code,
  message,
  now,
}) {
  requireState(state);
  launchId = requireId(launchId, "launchId");
  expectedPhase = requireId(expectedPhase, "expectedPhase");
  code = requireId(code, "code");
  message = boundedMessage(message);
  now = requireTimestamp(now);

  const { index, launch } = findLaunch(state, launchId);
  requirePhase(launch, expectedPhase);
  requireNondecreasingTime(launch, now);
  return replaceLaunch(state, index, {
    ...launch,
    updatedAt: now,
    lastError: {
      code,
      message,
      at: now,
    },
  }, {
    launchId,
    phase: launch.phase,
    errorCode: code,
  });
}

export function promotePendingLaunch(state, {
  launchId,
  now,
  historyFile = null,
}) {
  requireState(state);
  launchId = requireId(launchId, "launchId");
  now = requireTimestamp(now);
  historyFile = requireHistoryFile(historyFile);

  const { index, launch } = findLaunch(state, launchId);
  if (launch.phase !== "fork_assignment_started") {
    requirePhase(launch, "assignment_started");
  }
  requireNondecreasingTime(launch, now);
  requireParentOpen(state, launch.parentTaskId);
  ensureChildAvailable(
    state,
    launch.id,
    launch.parentTaskId,
    launch.childTaskId,
  );

  const readyLink = {
    parentTaskId: launch.parentTaskId,
    childTaskId: launch.childTaskId,
    ...(launch.sourceTaskId === undefined
      ? {}
      : { sourceTaskId: launch.sourceTaskId }),
    role: launch.role,
    lifecycle: "open",
    createdAt: now,
    updatedAt: now,
    historyFile,
    acceptedAt: null,
    acceptanceReason: null,
  };
  safeForest([...state.links, readyLink]);

  const nextState = {
    ...state,
    managedTasks: [...state.managedTasks, {
      taskId: launch.childTaskId,
      name: launch.name,
      role: launch.role,
      createdAt: now,
    }],
    pendingLaunches: state.pendingLaunches.filter(
      (_, currentIndex) => currentIndex !== index,
    ),
    links: [...state.links, readyLink],
  };
  const managedParent = state.managedTasks.find(
    ({ taskId }) => taskId === launch.parentTaskId,
  );
  const incomingParent = safeForest(state.links)
    .linkByChildTaskId.get(launch.parentTaskId);
  const conversation = startConversation(nextState, {
    conversationId: launch.id,
    initiatorTaskId: launch.parentTaskId,
    initiatorRole: managedParent?.role ?? incomingParent?.role ?? "controller",
    responderTaskId: launch.childTaskId,
    responderRole: launch.role,
    now,
  });
  return {
    state: conversation.state,
    result: {
      launchId,
      name: launch.name,
      parentTaskId: launch.parentTaskId,
      ...(launch.sourceTaskId === undefined
        ? {}
        : { sourceTaskId: launch.sourceTaskId }),
      childTaskId: launch.childTaskId,
      role: launch.role,
      phase: "ready",
    },
  };
}

function requireLaunchInput(input, { allowSource = false } = {}) {
  const requiredKeys = new Set([
    "assignment",
    "name",
    "parentTaskId",
    "projectRoot",
    "role",
  ]);
  const allowedKeys = new Set([
    ...requiredKeys,
    "model",
    "reasoningEffort",
    "serviceTier",
    ...(allowSource ? ["sourceTaskId"] : []),
  ]);
  const keys = input !== null
    && typeof input === "object"
    && !Array.isArray(input)
    ? Object.keys(input)
    : [];
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || keys.some((key) => !allowedKeys.has(key))
    || [...requiredKeys].some((key) => !keys.includes(key))
    || typeof input.projectRoot !== "string"
    || !path.isAbsolute(input.projectRoot)
  ) {
    throw new TypeError(
      "launchTask input must contain assignment, name, absolute projectRoot, parentTaskId, and role, with optional execution profile overrides",
    );
  }
  const executionOverride = requireExecutionOverride({
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    serviceTier: input.serviceTier ?? null,
  });
  const parentTaskId = requireId(input.parentTaskId, "parentTaskId");
  return {
    assignment: requireAssignment(input.assignment),
    projectRoot: input.projectRoot,
    name: requireName(input.name),
    parentTaskId,
    ...(allowSource
      ? {
        sourceTaskId: requireId(
          input.sourceTaskId ?? parentTaskId,
          "sourceTaskId",
        ),
      }
      : {}),
    role: requireRole(input.role),
    ...executionOverride,
  };
}

function publicError(code, message, details = {}) {
  return launchError(code, message, {
    run: details.run ?? "failed",
    operation: "launch",
    ...details,
  });
}

function withPublicDetails(error, details) {
  if (error instanceof TaskLaunchError) {
    error.run = details.run;
    error.operation = "launch";
    Object.assign(error, details);
    return error;
  }
  return publicError(
    "LAUNCH_REPAIR_REQUIRED",
    "Task launch could not safely continue",
    { ...details, cause: error },
  );
}

function defaultOpenHistory(historyFile) {
  return createReadStream(historyFile);
}

function createDependencies(options) {
  return {
    resolveProject: options.resolveProject ?? resolveProject,
    assertRuntimeAvailable:
      options.assertRuntimeAvailable ?? assertRuntimeAvailable,
    observeLatestTask: options.observeLatestTask ?? observeLatestTask,
    openHistory: options.openHistory ?? defaultOpenHistory,
    readSessionMetadata:
      options.readSessionMetadata ?? readCodexSessionMetadata,
    transactTaskLedger:
      options.transactTaskLedger ?? transactTaskLedger,
    createLaunchId: options.createLaunchId ?? randomUUID,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

function observationOptions(options) {
  return {
    roots: options.roots,
    fileSystem: options.sessionFileSystem,
    openHistory: options.sessionOpenHistory,
  };
}

async function preflightProjectTask(
  project,
  taskId,
  dependencies,
  options,
  {
    archivedCode,
    detailKey,
    label,
    notFoundCode,
    projectMismatchCode,
  },
) {
  const snapshot = await dependencies.observeLatestTask(
    taskId,
    observationOptions(options),
  );
  if (
    snapshot?.location === "missing"
    || snapshot?.historyFile === null
    || snapshot?.historyFile === undefined
  ) {
    throw publicError(
      notFoundCode,
      `${label} was not found in Codex session storage`,
      { [detailKey]: taskId },
    );
  }
  if (snapshot.location === "archived") {
    throw publicError(
      archivedCode,
      `An archived ${label} cannot be used to launch work`,
      { [detailKey]: taskId },
    );
  }
  if (snapshot.location !== "active") {
    throw publicError(
      notFoundCode,
      `${label} location could not be proven`,
      { [detailKey]: taskId },
    );
  }

  let metadata;
  try {
    const readable = await dependencies.openHistory(snapshot.historyFile);
    metadata = await dependencies.readSessionMetadata(
      readable,
      taskId,
    );
  } catch (cause) {
    throw publicError(
      notFoundCode,
      `${label} session identity could not be read`,
      { [detailKey]: taskId, cause },
    );
  }

  let taskProject;
  try {
    taskProject = await dependencies.resolveProject(metadata.cwd);
  } catch (cause) {
    throw publicError(
      projectMismatchCode,
      `${label} project identity could not be resolved`,
      { [detailKey]: taskId, cause },
    );
  }
  if (
    taskProject.root !== project.root
    || taskProject.key !== project.key
  ) {
    throw publicError(
      projectMismatchCode,
      `${label} belongs to another canonical project`,
      { [detailKey]: taskId },
    );
  }
  return snapshot;
}

function preflightParent(project, parentTaskId, dependencies, options) {
  return preflightProjectTask(
    project,
    parentTaskId,
    dependencies,
    options,
    {
      archivedCode: "PARENT_TASK_ARCHIVED",
      detailKey: "parentTaskId",
      label: "Parent Task",
      notFoundCode: "PARENT_TASK_NOT_FOUND",
      projectMismatchCode: "PROJECT_ROOT_MISMATCH",
    },
  );
}

function preflightForkSource(
  project,
  sourceTaskId,
  dependencies,
  options,
) {
  return preflightProjectTask(
    project,
    sourceTaskId,
    dependencies,
    options,
    {
      archivedCode: "FORK_SOURCE_TASK_ARCHIVED",
      detailKey: "sourceTaskId",
      label: "Fork source Task",
      notFoundCode: "FORK_SOURCE_TASK_NOT_FOUND",
      projectMismatchCode: "FORK_SOURCE_PROJECT_ROOT_MISMATCH",
    },
  );
}

async function recordFailure(
  transaction,
  launchId,
  phase,
  code,
  error,
  timestamp,
) {
  try {
    await transaction(
      (state) => recordPendingLaunchError(state, {
        launchId,
        expectedPhase: phase,
        code,
        message: errorDiagnosticMessage(error, code),
        now: timestamp,
      }),
      timestamp,
    );
    return null;
  } catch (evidenceError) {
    return evidenceError;
  }
}

function childCreationCode(error) {
  if (error?.code === "TASK_EXECUTION_PROFILE_MISMATCH") {
    return "LAUNCH_CHILD_PROFILE_MISMATCH";
  }
  if (error?.code === "TASK_RUN_CONTEXT_MISMATCH") {
    return "LAUNCH_CHILD_AUTHORITY_MISMATCH";
  }
  if (error?.code === "TASK_RUN_CONTEXT_INVALID") {
    return "LAUNCH_CHILD_AUTHORITY_INVALID";
  }
  return new Set([
    "APP_SERVER_REQUEST_FAILED",
    "APP_SERVER_START_FAILED",
  ]).has(error?.code)
    ? "LAUNCH_CHILD_CREATE_FAILED"
    : "LAUNCH_CHILD_ID_UNKNOWN";
}

async function createManagedTask(input, options, operation) {
  const deferredFork = operation === "continue-fork";
  const continuingRole = operation === "continue-role";
  let projectRoot;
  let name;
  let assignment;
  let parentTaskId;
  let sourceTaskId = null;
  let role;
  let launchId;
  let model = null;
  let reasoningEffort = null;
  let serviceTier = null;
  if (deferredFork || continuingRole) {
    if (
      input === null
      || typeof input !== "object"
      || Array.isArray(input)
      || Object.keys(input).sort().join(",") !== "launchId,projectRoot"
      || typeof input.projectRoot !== "string"
      || !path.isAbsolute(input.projectRoot)
    ) {
      throw new TypeError(
        "continuation input must contain only launchId and absolute projectRoot",
      );
    }
    projectRoot = input.projectRoot;
    launchId = requireId(input.launchId, "launchId");
  } else {
    ({
      projectRoot,
      name,
      assignment,
      parentTaskId,
      sourceTaskId,
      role,
      model,
      reasoningEffort,
      serviceTier,
    } = requireLaunchInput(input));
  }
  const dependencies = createDependencies(options);
  const project = await dependencies.resolveProject(projectRoot);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);

  let runtime;
  try {
    runtime = await dependencies.assertRuntimeAvailable(project, {
      ...observationOptions(options),
      store,
      nowMs: options.nowMs,
    });
  } catch (cause) {
    throw publicError(
      "RUNTIME_NOT_AVAILABLE",
      `Codex Small Loop Project Runtime could not be read safely. Run node ${JSON.stringify(RUNTIME_SCRIPT)} status --project-root ${JSON.stringify(project.root)} to diagnose the current state. Resolve the reported issue, then retry task create.`,
      { parentTaskId, cause },
    );
  }
  const transaction = (transform, now) => (
    dependencies.transactTaskLedger(
      store,
      project,
      transform,
      { now },
    )
  );

  let now = requireTimestamp(dependencies.now());
  let forkLaunch = deferredFork;
  const preCreationPhase = deferredFork ? "fork_queued" : "prepared";
  let creatingPhase = deferredFork ? "fork_creating" : "creating";
  let childCreatedPhase = deferredFork
    ? "fork_child_created"
    : "child_created";
  let roleStartedPhase = deferredFork
    ? "fork_role_started"
    : "role_started";
  let assignmentStartingPhase = deferredFork
    ? "fork_assignment_starting"
    : "assignment_starting";
  let assignmentStartedPhase = deferredFork
    ? "fork_assignment_started"
    : "assignment_started";

  let continuedRoleTurnId = null;
  let continuedChildTaskId = null;
  if (continuingRole) {
    const pending = findLaunch(runtime.ledger, launchId).launch;
    if (
      pending.phase !== "role_started"
      && pending.phase !== "fork_role_started"
    ) {
      requirePhase(pending, "role_started");
    }
    forkLaunch = pending.phase === "fork_role_started";
    creatingPhase = forkLaunch ? "fork_creating" : "creating";
    childCreatedPhase = forkLaunch
      ? "fork_child_created"
      : "child_created";
    roleStartedPhase = pending.phase;
    assignmentStartingPhase = forkLaunch
      ? "fork_assignment_starting"
      : "assignment_starting";
    assignmentStartedPhase = forkLaunch
      ? "fork_assignment_started"
      : "assignment_started";
    ({
      assignment,
      childTaskId: continuedChildTaskId,
      name,
      parentTaskId,
      sourceTaskId,
      role,
      roleTurnId: continuedRoleTurnId,
      model,
      reasoningEffort,
      serviceTier,
    } = pending);
    sourceTaskId ??= parentTaskId;
  } else if (deferredFork) {
    const queued = findLaunch(runtime.ledger, launchId).launch;
    requirePhase(queued, "fork_queued");
    ({
      assignment,
      name,
      parentTaskId,
      sourceTaskId,
      role,
      model,
      reasoningEffort,
      serviceTier,
    } = queued);
    sourceTaskId ??= parentTaskId;
    const parent = await preflightParent(
      project,
      parentTaskId,
      dependencies,
      options,
    );
    if (parent.turnState !== "ended") {
      throw publicError(
        "DEFERRED_FORK_PARENT_ACTIVE",
        "The deferred fork still requires an ended Parent turn",
        {
          launchId,
          parentTaskId,
          phase: "fork_queued",
        },
      );
    }
    const source = sourceTaskId === parentTaskId
      ? parent
      : await preflightForkSource(
        project,
        sourceTaskId,
        dependencies,
        options,
      );
    if (source.turnState !== "ended") {
      throw publicError(
        "DEFERRED_FORK_SOURCE_ACTIVE",
        "The deferred fork still requires an ended fork source turn",
        {
          launchId,
          parentTaskId,
          sourceTaskId,
          phase: "fork_queued",
        },
      );
    }
  } else {
    await preflightParent(
      project,
      parentTaskId,
      dependencies,
      options,
    );
    launchId = requireId(
      dependencies.createLaunchId(),
      "launchId",
    );
    await transaction(
      (state) => preparePendingLaunch(state, {
        assignment,
        launchId,
        model,
        name,
        parentTaskId,
        reasoningEffort,
        role,
        serviceTier,
        now,
      }),
      now,
    );
  }

  const appServer = options.appServer
    ?? new CodexAppServerClient({
      command: options.codexCommand,
      args: options.codexArgs,
      cwd: project.root,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
  let childTaskId = null;
  let roleTurnId = null;
  let assignmentTurnId = null;
  let childRunContext = null;

  try {
    const managedParent = runtime.ledger.managedTasks.find(
      (task) => task?.taskId === parentTaskId,
    );
    const parentLink = safeForest(runtime.ledger.links)
      .linkByChildTaskId.get(parentTaskId);
    const parentRole = requireRole(
      managedParent?.role ?? parentLink?.role ?? "controller",
    );
    const managedSource = forkLaunch
      ? runtime.ledger.managedTasks.find(
        (task) => task?.taskId === sourceTaskId,
      )
      : managedParent;
    const sourceLink = forkLaunch
      ? safeForest(runtime.ledger.links).linkByChildTaskId.get(sourceTaskId)
      : parentLink;
    const sourceRole = requireRole(
      managedSource?.role ?? sourceLink?.role ?? "controller",
    );

    if (continuingRole) {
      childTaskId = continuedChildTaskId;
      roleTurnId = continuedRoleTurnId;
    } else {
      let runContext;
      try {
        runContext = resolveRunContext(
          await appServer.readTaskProfile({
            taskId: forkLaunch ? sourceTaskId : parentTaskId,
          }),
          { model, reasoningEffort, serviceTier },
        );
      } catch (cause) {
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          preCreationPhase,
          "LAUNCH_PARENT_PROFILE_FAILED",
          cause,
          now,
        );
        throw publicError(
          "LAUNCH_PARENT_PROFILE_FAILED",
          "Parent Task execution profile could not be inherited safely",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId: null,
            phase: preCreationPhase,
            cause,
            evidenceError,
          },
        );
      }

      now = requireTimestamp(dependencies.now());
      await transaction(
        (state) => advancePendingLaunch(state, {
          launchId,
          expectedPhase: preCreationPhase,
          phase: creatingPhase,
          now,
        }),
        now,
      );

      try {
        const child = deferredFork
          ? await appServer.forkTask({
            taskId: sourceTaskId,
            cwd: project.root,
            runContext,
          })
          : await appServer.createTask({
            cwd: project.root,
            runContext,
          });
        childTaskId = child.taskId;
        childRunContext = requireTaskRunContext(child.runContext);
      } catch (cause) {
        const code = childCreationCode(cause);
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          creatingPhase,
          code,
          cause,
          now,
        );
        throw publicError(
          code,
          "Codex Child Task creation did not produce a durable Task ID",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId: null,
            phase: creatingPhase,
            cause,
            evidenceError,
          },
        );
      }

      now = requireTimestamp(dependencies.now());
      try {
        await transaction(
          (state) => advancePendingLaunch(state, {
            launchId,
            expectedPhase: creatingPhase,
            phase: childCreatedPhase,
            childTaskId,
            now,
          }),
          now,
        );
      } catch (cause) {
        throw publicError(
          "LAUNCH_REPAIR_REQUIRED",
          "Child Task exists but its ID could not be persisted",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            phase: creatingPhase,
            cause,
          },
        );
      }

      try {
        if (typeof appServer.setTaskName !== "function") {
          throw new TypeError("Codex App control cannot name the Child Task");
        }
        await appServer.setTaskName({
          taskId: childTaskId,
          name,
        });
      } catch (cause) {
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          childCreatedPhase,
          "LAUNCH_TASK_NAME_FAILED",
          cause,
          now,
        );
        throw publicError(
          "LAUNCH_TASK_NAME_FAILED",
          "Child Task exists but its Codex Task name could not be set",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            phase: childCreatedPhase,
            cause,
            evidenceError,
          },
        );
      }

      try {
        ({ turnId: roleTurnId } = await appServer.startTurn({
          taskId: childTaskId,
          text: forkLaunch
            ? renderForkNotification({
              currentRole: role,
              currentTaskId: childTaskId,
              parentTaskId,
              previousRole: sourceRole,
              sourceTaskId,
            })
            : renderLaunchRoleInstructions({
              childTaskId,
              parentTaskId,
              role,
            }),
          cwd: project.root,
          runContext: childRunContext,
        }));
      } catch (cause) {
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          childCreatedPhase,
          "LAUNCH_ROLE_FAILED",
          cause,
          now,
        );
        throw publicError(
          "LAUNCH_ROLE_FAILED",
          "Child Task Role Turn did not produce a durable Turn ID",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            phase: childCreatedPhase,
            cause,
            evidenceError,
          },
        );
      }

      now = requireTimestamp(dependencies.now());
      try {
        await transaction(
          (state) => advancePendingLaunch(state, {
            launchId,
            expectedPhase: childCreatedPhase,
            phase: roleStartedPhase,
            roleTurnId,
            now,
          }),
          now,
        );
      } catch (cause) {
        throw publicError(
          "LAUNCH_REPAIR_REQUIRED",
          "Role Turn exists but its ID could not be persisted",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            roleTurnId,
            phase: childCreatedPhase,
            cause,
          },
        );
      }

      let roleResult;
      try {
        roleResult = await appServer.waitForTurn({
          taskId: childTaskId,
          turnId: roleTurnId,
        });
      } catch (cause) {
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          roleStartedPhase,
          "LAUNCH_ROLE_WAIT_FAILED",
          cause,
          now,
        );
        throw publicError(
          "LAUNCH_ROLE_WAIT_FAILED",
          "Child Task Role Turn did not reach a confirmed completion",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            roleTurnId,
            phase: roleStartedPhase,
            cause,
            evidenceError,
          },
        );
      }
      if (roleResult?.status !== "completed") {
        const cause = new Error(
          `Role Turn ended with status ${roleResult?.status ?? "unknown"}`,
        );
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          roleStartedPhase,
          "LAUNCH_ROLE_INCOMPLETE",
          cause,
          now,
        );
        throw publicError(
          "LAUNCH_ROLE_INCOMPLETE",
          "Child Task Role Turn was interrupted or failed",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            roleTurnId,
            phase: roleStartedPhase,
            cause,
            evidenceError,
          },
        );
      }
    }

    if (childRunContext === null) {
      try {
        childRunContext = requireTaskRunContext(
          (await appServer.resumeTask({ taskId: childTaskId })).runContext,
        );
      } catch (cause) {
        now = requireTimestamp(dependencies.now());
        const evidenceError = await recordFailure(
          transaction,
          launchId,
          roleStartedPhase,
          "LAUNCH_CHILD_PROFILE_FAILED",
          cause,
          now,
        );
        throw publicError(
          "LAUNCH_CHILD_PROFILE_FAILED",
          "Child Task execution profile could not be resumed safely",
          {
            run: "partial",
            launchId,
            parentTaskId,
            childTaskId,
            roleTurnId,
            phase: roleStartedPhase,
            cause,
            evidenceError,
          },
        );
      }
    }

    now = requireTimestamp(dependencies.now());
    try {
      await transaction(
        (state) => advancePendingLaunch(state, {
          launchId,
          expectedPhase: roleStartedPhase,
          phase: assignmentStartingPhase,
          now,
        }),
        now,
      );
    } catch (cause) {
      throw publicError(
        "LAUNCH_ASSIGNMENT_CLAIM_FAILED",
        "The completed Role Turn could not claim one assignment start",
        {
          run: "partial",
          launchId,
          parentTaskId,
          childTaskId,
          roleTurnId,
          phase: roleStartedPhase,
          cause,
        },
      );
    }

    try {
      ({ turnId: assignmentTurnId } = await appServer.startTurn({
        taskId: childTaskId,
        text: renderConversationMessage({
          conversationId: launchId,
          initiatorTaskId: parentTaskId,
          initiatorRole: parentRole,
          operation: "start",
          responderTaskId: childTaskId,
          responderRole: role,
          scheduleId: null,
          text: assignment,
        }),
        cwd: project.root,
        runContext: childRunContext,
      }));
    } catch (cause) {
      now = requireTimestamp(dependencies.now());
      const evidenceError = await recordFailure(
        transaction,
        launchId,
        assignmentStartingPhase,
        "LAUNCH_ASSIGNMENT_FAILED",
        cause,
        now,
      );
      throw publicError(
        "LAUNCH_ASSIGNMENT_FAILED",
        "Child Task assignment did not produce a durable Turn ID",
        {
          run: "partial",
          launchId,
          parentTaskId,
          childTaskId,
          phase: assignmentStartingPhase,
          cause,
          evidenceError,
        },
      );
    }

    now = requireTimestamp(dependencies.now());
    try {
      await transaction(
        (state) => advancePendingLaunch(state, {
          launchId,
          expectedPhase: assignmentStartingPhase,
          phase: assignmentStartedPhase,
          assignmentTurnId,
          now,
        }),
        now,
      );
    } catch (cause) {
      throw publicError(
        "LAUNCH_REPAIR_REQUIRED",
        "Assignment Turn exists but its ID could not be persisted",
        {
          run: "partial",
          launchId,
          parentTaskId,
          childTaskId,
          assignmentTurnId,
          phase: assignmentStartingPhase,
          cause,
        },
      );
    }

    now = requireTimestamp(dependencies.now());
    let promotion;
    try {
      promotion = await transaction(
        (state) => promotePendingLaunch(state, {
          launchId,
          now,
        }),
        now,
      );
    } catch (cause) {
      throw withPublicDetails(cause, {
        run: "partial",
        launchId,
        parentTaskId,
        childTaskId,
        assignmentTurnId,
        phase: assignmentStartedPhase,
      });
    }

    return Object.freeze({
      run: "ok",
      operation: forkLaunch ? "fork" : "launch",
      ...promotion.result,
      nextAction: {
        type: "end_turn",
        required: true,
        reason: "The Child assignment started; end this turn so its callback can resume the parent cleanly.",
      },
    });
  } finally {
    await appServer.close();
  }
}

export function launchTask(input, options = {}) {
  return createManagedTask(input, options, "launch");
}

export async function forkTask(input, options = {}) {
  const {
    projectRoot,
    name,
    assignment,
    parentTaskId,
    sourceTaskId,
    role,
    model,
    reasoningEffort,
    serviceTier,
  } = requireLaunchInput(input, { allowSource: true });
  const dependencies = createDependencies(options);
  const project = await dependencies.resolveProject(projectRoot);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);

  try {
    await dependencies.assertRuntimeAvailable(project, {
      ...observationOptions(options),
      store,
      nowMs: options.nowMs,
    });
    await preflightParent(
      project,
      parentTaskId,
      dependencies,
      options,
    );
    if (sourceTaskId !== parentTaskId) {
      await preflightForkSource(
        project,
        sourceTaskId,
        dependencies,
        options,
      );
    }
    const launchId = requireId(
      dependencies.createLaunchId(),
      "launchId",
    );
    const now = requireTimestamp(dependencies.now());
    await dependencies.transactTaskLedger(
      store,
      project,
      (state) => preparePendingLaunch(state, {
        assignment,
        launchId,
        model,
        name,
        parentTaskId,
        sourceTaskId,
        phase: "fork_queued",
        reasoningEffort,
        role,
        serviceTier,
        now,
      }),
      { now },
    );
    return Object.freeze({
      run: "ok",
      operation: "fork",
      launchId,
      name,
      parentTaskId,
      sourceTaskId,
      role,
      phase: "fork_queued",
      nextAction: {
        type: "end_turn",
        required: true,
        reason: "The fork starts after this Parent turn completes.",
      },
    });
  } catch (error) {
    if (error && typeof error === "object") {
      error.operation = "fork";
    }
    throw error;
  }
}

export async function continueDeferredFork(input, options = {}) {
  try {
    return await createManagedTask(input, options, "continue-fork");
  } catch (error) {
    if (error && typeof error === "object") {
      error.operation = "fork";
    }
    throw error;
  }
}

export async function continuePendingRoleLaunch(input, options = {}) {
  try {
    return await createManagedTask(input, options, "continue-role");
  } catch (error) {
    if (error && typeof error === "object") {
      error.operation = "role-continuation";
    }
    throw error;
  }
}
