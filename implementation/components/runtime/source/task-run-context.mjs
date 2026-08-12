const MAX_IDENTIFIER_LENGTH = 512;
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);
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
const SANDBOX_POLICY_TYPES = new Set([
  "dangerFullAccess",
  "externalSandbox",
  "readOnly",
  "workspaceWrite",
]);
const THREAD_SANDBOX_MODES = new Map([
  ["dangerFullAccess", "danger-full-access"],
  ["readOnly", "read-only"],
  ["workspaceWrite", "workspace-write"],
]);

function clone(value) {
  return structuredClone(value);
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || /\s/.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded identifier`);
  }
  return value;
}

function requireApprovalPolicy(value) {
  if (APPROVAL_POLICIES.has(value)) {
    return value;
  }
  const granular = value?.granular;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || granular === null
    || typeof granular !== "object"
    || Array.isArray(granular)
    || typeof granular.mcp_elicitations !== "boolean"
    || typeof granular.rules !== "boolean"
    || typeof granular.sandbox_approval !== "boolean"
    || (
      granular.request_permissions !== undefined
      && typeof granular.request_permissions !== "boolean"
    )
    || (
      granular.skill_approval !== undefined
      && typeof granular.skill_approval !== "boolean"
    )
  ) {
    throw new TypeError("approvalPolicy is missing or invalid");
  }
  return clone(value);
}

function requireExecutionProfile({ model, reasoningEffort, serviceTier }) {
  model = requireIdentifier(model, "model");
  if (
    reasoningEffort !== null
    && !REASONING_EFFORTS.has(reasoningEffort)
  ) {
    throw new TypeError(
      "reasoningEffort must be null or a supported reasoning effort",
    );
  }
  if (serviceTier === "default") {
    serviceTier = null;
  } else if (serviceTier !== null) {
    serviceTier = requireIdentifier(serviceTier, "serviceTier");
  }
  return { model, reasoningEffort, serviceTier };
}

function requireSandboxPolicy(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !SANDBOX_POLICY_TYPES.has(value.type)
  ) {
    throw new TypeError("sandbox permission is missing or invalid");
  }
  return clone(value);
}

function deepFreeze(value) {
  if (
    value !== null
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function freezeContext(context) {
  return deepFreeze(context);
}

export function taskRunContextFromSettings(settings) {
  if (
    settings === null
    || typeof settings !== "object"
    || Array.isArray(settings)
  ) {
    throw new TypeError("task run settings must be an object");
  }
  const profile = requireExecutionProfile(settings);
  const approvalPolicy = requireApprovalPolicy(settings.approvalPolicy);
  const activeProfile = settings.activePermissionProfile ?? null;
  let permission;

  if (activeProfile !== null) {
    if (
      typeof activeProfile !== "object"
      || Array.isArray(activeProfile)
      || !activeProfile.id
    ) {
      throw new TypeError("active permission profile is invalid");
    }
    permission = {
      type: "profile",
      id: requireIdentifier(activeProfile.id, "permission profile id"),
    };
  } else {
    permission = {
      type: "sandbox",
      policy: requireSandboxPolicy(
        settings.sandboxPolicy ?? settings.sandbox ?? null,
      ),
    };
  }

  return freezeContext({
    ...profile,
    approvalPolicy,
    permission,
  });
}

export function overrideTaskRunContext(context, overrides = {}) {
  const normalized = requireTaskRunContext(context);
  if (
    overrides === null
    || typeof overrides !== "object"
    || Array.isArray(overrides)
  ) {
    throw new TypeError("execution overrides must be an object");
  }
  const profile = requireExecutionProfile({
    model: overrides.model === undefined ? normalized.model : overrides.model,
    reasoningEffort: overrides.reasoningEffort === undefined
      ? normalized.reasoningEffort
      : overrides.reasoningEffort,
    serviceTier: overrides.serviceTier === undefined
      ? normalized.serviceTier
      : overrides.serviceTier,
  });
  return freezeContext({
    ...profile,
    approvalPolicy: clone(normalized.approvalPolicy),
    permission: clone(normalized.permission),
  });
}

export function requireTaskRunContext(context) {
  if (
    context === null
    || typeof context !== "object"
    || Array.isArray(context)
  ) {
    throw new TypeError("taskRunContext must be an object");
  }
  const profile = requireExecutionProfile(context);
  const approvalPolicy = requireApprovalPolicy(context.approvalPolicy);
  let permission;
  if (context.permission?.type === "profile") {
    permission = {
      type: "profile",
      id: requireIdentifier(context.permission.id, "permission profile id"),
    };
  } else if (context.permission?.type === "sandbox") {
    permission = {
      type: "sandbox",
      policy: requireSandboxPolicy(context.permission.policy),
    };
  } else {
    throw new TypeError("taskRunContext permission is missing or invalid");
  }
  return freezeContext({
    ...profile,
    approvalPolicy,
    permission,
  });
}

export function turnSettingsFromTaskRunContext(context) {
  context = requireTaskRunContext(context);
  return {
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    serviceTier: context.serviceTier,
    approvalPolicy: clone(context.approvalPolicy),
    ...(context.permission.type === "profile"
      ? { permissions: context.permission.id }
      : { sandboxPolicy: clone(context.permission.policy) }),
  };
}

export function threadSettingsFromTaskRunContext(context) {
  context = requireTaskRunContext(context);
  if (context.permission.type === "profile") {
    return {
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      serviceTier: context.serviceTier,
      approvalPolicy: clone(context.approvalPolicy),
      permissions: context.permission.id,
    };
  }
  if (Object.keys(context.permission.policy).length !== 1) {
    throw new TypeError(
      `Sandbox permission ${context.permission.policy.type} cannot be represented without losing policy details when creating or forking a task`,
    );
  }
  const sandbox = THREAD_SANDBOX_MODES.get(context.permission.policy.type);
  if (!sandbox) {
    throw new TypeError(
      `Sandbox permission ${context.permission.policy.type} cannot be represented when creating or forking a task`,
    );
  }
  return {
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    serviceTier: context.serviceTier,
    approvalPolicy: clone(context.approvalPolicy),
    sandbox,
  };
}

export function executionProfileFromTaskRunContext(context) {
  context = requireTaskRunContext(context);
  return Object.freeze({
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    serviceTier: context.serviceTier,
  });
}
