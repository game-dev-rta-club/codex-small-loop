const CONVERSATION_STATES = new Set([
  "awaiting_reply",
  "replied",
  "accepted",
]);
const ROLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 1_024;
const CONVERSATION_KEYS = [
  "acceptedAt",
  "createdAt",
  "id",
  "initiatorRole",
  "initiatorTaskId",
  "repliedAt",
  "responderRole",
  "responderTaskId",
  "state",
  "updatedAt",
];

export class ConversationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConversationError";
    this.code = code;
  }
}

function error(code, message) {
  return new ConversationError(code, message);
}

function requireId(value, field) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ID_LENGTH
    || /\s/.test(value)
  ) {
    throw error(
      "CONVERSATION_INVALID",
      `${field} must be a non-empty bounded identifier.`,
    );
  }
  return value;
}

function requireRole(value, field) {
  if (
    typeof value !== "string"
    || value.length > 128
    || !ROLE_PATTERN.test(value)
  ) {
    throw error(
      "CONVERSATION_INVALID",
      `${field} must be a valid Job Role.`,
    );
  }
  return value;
}

function requireTimestamp(value, field) {
  if (
    typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw error(
      "CONVERSATION_INVALID",
      `${field} must be an ISO timestamp.`,
    );
  }
  return value;
}

function requireNullableTimestamp(value, field) {
  if (value === null) return null;
  return requireTimestamp(value, field);
}

function requireTimeOrder(earlier, later, field) {
  if (Date.parse(earlier) > Date.parse(later)) {
    throw error(
      "CONVERSATION_INVALID",
      `${field} timestamps are out of order.`,
    );
  }
}

function requireExactRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error(
      "CONVERSATION_INVALID",
      "Conversation must be an object.",
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...CONVERSATION_KEYS].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw error(
      "CONVERSATION_INVALID",
      "Conversation contains missing or unsupported fields.",
    );
  }
}

function requireState(state) {
  if (!state || !Array.isArray(state.conversations)) {
    throw error(
      "CONVERSATION_INVALID",
      "Conversation state must contain a conversations array.",
    );
  }
  return state;
}

function requireConversation(state, conversationId) {
  requireState(state);
  conversationId = requireId(conversationId, "conversationId");
  const index = state.conversations.findIndex(
    ({ id }) => id === conversationId,
  );
  if (index === -1) {
    throw error(
      "CONVERSATION_NOT_FOUND",
      "Conversation does not exist.",
    );
  }
  return {
    conversation: state.conversations[index],
    index,
  };
}

function replaceConversation(state, index, conversation) {
  const conversations = [...state.conversations];
  conversations[index] = conversation;
  return {
    state: { ...state, conversations },
    conversation,
  };
}

function activeConversations(state, excludedId = null) {
  return state.conversations.filter(
    ({ id, state: currentState }) =>
      id !== excludedId && currentState === "awaiting_reply",
  );
}

function assertResponderAvailable(state, responderTaskId, excludedId = null) {
  const conflict = activeConversations(state, excludedId).find(
    ({ responderTaskId: currentResponder }) =>
      currentResponder === responderTaskId,
  );
  if (conflict) {
    throw error(
      "MESSAGE_TARGET_BUSY",
      `This task cannot enter a new conversation because it currently owes a reply to another message. Current conversation: ${conflict.id}`,
    );
  }
}

function assertAcyclic(state, initiatorTaskId, responderTaskId, excludedId = null) {
  const children = new Map();
  for (const conversation of activeConversations(state, excludedId)) {
    const current = children.get(conversation.initiatorTaskId) ?? [];
    current.push(conversation.responderTaskId);
    children.set(conversation.initiatorTaskId, current);
  }
  const initial = children.get(initiatorTaskId) ?? [];
  children.set(initiatorTaskId, [...initial, responderTaskId]);

  const pending = [responderTaskId];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === initiatorTaskId) {
      throw error(
        "CONVERSATION_CYCLE",
        "Conversation would create a reply cycle.",
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(children.get(current) ?? []));
  }
}

export function startConversation(state, input) {
  requireState(state);
  const id = requireId(input?.conversationId, "conversationId");
  const initiatorTaskId = requireId(
    input?.initiatorTaskId,
    "initiatorTaskId",
  );
  const responderTaskId = requireId(
    input?.responderTaskId,
    "responderTaskId",
  );
  const initiatorRole = requireRole(input?.initiatorRole, "initiatorRole");
  const responderRole = requireRole(input?.responderRole, "responderRole");
  const now = requireTimestamp(input?.now, "now");
  if (initiatorTaskId === responderTaskId) {
    throw error(
      "CONVERSATION_SELF_TARGET",
      "A task cannot start a conversation with itself.",
    );
  }
  if (state.conversations.some((conversation) => conversation.id === id)) {
    throw error(
      "CONVERSATION_EXISTS",
      "Conversation ID already exists.",
    );
  }
  assertResponderAvailable(state, responderTaskId);
  assertAcyclic(state, initiatorTaskId, responderTaskId);

  const conversation = {
    id,
    initiatorTaskId,
    initiatorRole,
    responderTaskId,
    responderRole,
    state: "awaiting_reply",
    createdAt: now,
    updatedAt: now,
    repliedAt: null,
    acceptedAt: null,
  };
  return {
    state: {
      ...state,
      conversations: [...state.conversations, conversation],
    },
    conversation,
  };
}

export function replyToConversation(state, input) {
  const { conversation, index } = requireConversation(
    state,
    input?.conversationId,
  );
  const senderTaskId = requireId(input?.senderTaskId, "senderTaskId");
  const now = requireTimestamp(input?.now, "now");
  if (senderTaskId !== conversation.responderTaskId) {
    throw error(
      "CONVERSATION_RESPONDER_REQUIRED",
      "Only the Conversation Responder may reply.",
    );
  }
  if (conversation.state !== "awaiting_reply") {
    throw error(
      "CONVERSATION_REPLY_NOT_EXPECTED",
      "Conversation is not waiting for a reply.",
    );
  }
  return replaceConversation(state, index, {
    ...conversation,
    state: "replied",
    updatedAt: now,
    repliedAt: now,
  });
}

export function continueConversation(state, input) {
  const { conversation, index } = requireConversation(
    state,
    input?.conversationId,
  );
  const senderTaskId = requireId(input?.senderTaskId, "senderTaskId");
  const now = requireTimestamp(input?.now, "now");
  if (senderTaskId !== conversation.initiatorTaskId) {
    throw error(
      "CONVERSATION_INITIATOR_REQUIRED",
      "Only the Conversation Initiator may continue it.",
    );
  }
  if (conversation.state === "accepted") {
    throw error(
      "CONVERSATION_ACCEPTED",
      `This Conversation is accepted and cannot continue. Start a new Conversation with conversation.mjs start --task ${conversation.responderTaskId}.`,
    );
  }
  if (conversation.state !== "replied") {
    throw error(
      "CONVERSATION_CONTINUE_NOT_ALLOWED",
      "Only a replied Conversation may continue.",
    );
  }
  assertResponderAvailable(
    state,
    conversation.responderTaskId,
    conversation.id,
  );
  assertAcyclic(
    state,
    conversation.initiatorTaskId,
    conversation.responderTaskId,
    conversation.id,
  );
  return replaceConversation(state, index, {
    ...conversation,
    state: "awaiting_reply",
    updatedAt: now,
    repliedAt: null,
  });
}

export function acceptConversation(state, input) {
  const { conversation, index } = requireConversation(
    state,
    input?.conversationId,
  );
  const senderTaskId = requireId(input?.senderTaskId, "senderTaskId");
  const now = requireTimestamp(input?.now, "now");
  if (senderTaskId !== conversation.initiatorTaskId) {
    throw error(
      "CONVERSATION_INITIATOR_REQUIRED",
      "Only the Conversation Initiator may accept it.",
    );
  }
  if (conversation.state !== "replied") {
    throw error(
      "CONVERSATION_ACCEPT_NOT_ALLOWED",
      "Only a replied Conversation may be accepted.",
    );
  }
  return replaceConversation(state, index, {
    ...conversation,
    state: "accepted",
    updatedAt: now,
    acceptedAt: now,
  });
}

export function validateConversation(conversation) {
  requireExactRecord(conversation);
  requireId(conversation.id, "conversation.id");
  requireId(conversation.initiatorTaskId, "conversation.initiatorTaskId");
  requireRole(conversation.initiatorRole, "conversation.initiatorRole");
  requireId(conversation.responderTaskId, "conversation.responderTaskId");
  requireRole(conversation.responderRole, "conversation.responderRole");
  if (conversation.initiatorTaskId === conversation.responderTaskId) {
    throw error(
      "CONVERSATION_INVALID",
      "Conversation cannot target its Initiator.",
    );
  }
  if (!CONVERSATION_STATES.has(conversation.state)) {
    throw error(
      "CONVERSATION_INVALID",
      "Conversation has an invalid state.",
    );
  }
  requireTimestamp(conversation.createdAt, "conversation.createdAt");
  requireTimestamp(conversation.updatedAt, "conversation.updatedAt");
  requireNullableTimestamp(conversation.repliedAt, "conversation.repliedAt");
  requireNullableTimestamp(conversation.acceptedAt, "conversation.acceptedAt");
  requireTimeOrder(
    conversation.createdAt,
    conversation.updatedAt,
    "Conversation",
  );

  if (
    conversation.state === "awaiting_reply"
    && (conversation.repliedAt !== null || conversation.acceptedAt !== null)
  ) {
    throw error(
      "CONVERSATION_INVALID",
      "An awaiting Conversation cannot have reply or acceptance timestamps.",
    );
  }
  if (
    conversation.state === "replied"
    && (conversation.repliedAt === null || conversation.acceptedAt !== null)
  ) {
    throw error(
      "CONVERSATION_INVALID",
      "A replied Conversation requires only a reply timestamp.",
    );
  }
  if (
    conversation.state === "accepted"
    && (conversation.repliedAt === null || conversation.acceptedAt === null)
  ) {
    throw error(
      "CONVERSATION_INVALID",
      "An accepted Conversation requires reply and acceptance timestamps.",
    );
  }
  if (conversation.repliedAt !== null) {
    requireTimeOrder(
      conversation.createdAt,
      conversation.repliedAt,
      "Conversation reply",
    );
    requireTimeOrder(
      conversation.repliedAt,
      conversation.updatedAt,
      "Conversation update",
    );
  }
  if (conversation.acceptedAt !== null) {
    requireTimeOrder(
      conversation.repliedAt,
      conversation.acceptedAt,
      "Conversation acceptance",
    );
    requireTimeOrder(
      conversation.acceptedAt,
      conversation.updatedAt,
      "Conversation update",
    );
  }
  return conversation;
}

export function validateConversationState(conversations) {
  if (!Array.isArray(conversations)) {
    throw error(
      "CONVERSATION_INVALID",
      "Conversation state must be an array.",
    );
  }
  const ids = new Set();
  const responderConversation = new Map();
  const activeState = { conversations: [] };

  for (const conversation of conversations) {
    validateConversation(conversation);
    if (ids.has(conversation.id)) {
      throw error(
        "CONVERSATION_INVALID",
        "Conversation IDs must be unique.",
      );
    }
    ids.add(conversation.id);
    if (conversation.state !== "awaiting_reply") continue;

    const conflict = responderConversation.get(
      conversation.responderTaskId,
    );
    if (conflict) {
      throw error(
        "MESSAGE_TARGET_BUSY",
        `This task cannot enter a new conversation because it currently owes a reply to another message. Current conversation: ${conflict}`,
      );
    }
    responderConversation.set(
      conversation.responderTaskId,
      conversation.id,
    );
    assertAcyclic(
      activeState,
      conversation.initiatorTaskId,
      conversation.responderTaskId,
    );
    activeState.conversations.push(conversation);
  }
  return conversations;
}
