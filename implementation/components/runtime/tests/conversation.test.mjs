import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptConversation,
  continueConversation,
  replyToConversation,
  startConversation,
  validateConversationState,
} from "../source/conversation.mjs";

const NOW = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T00:01:00.000Z";

function emptyState() {
  return { conversations: [] };
}

function start(state, overrides = {}) {
  return startConversation(state, {
    conversationId: "conversation-1",
    initiatorTaskId: "primary-task",
    initiatorRole: "primary",
    responderTaskId: "review-task",
    responderRole: "review",
    now: NOW,
    ...overrides,
  });
}

test("starts one conversation with a reply obligation", () => {
  const result = start(emptyState());

  assert.deepEqual(result.conversation, {
    id: "conversation-1",
    initiatorTaskId: "primary-task",
    initiatorRole: "primary",
    responderTaskId: "review-task",
    responderRole: "review",
    state: "awaiting_reply",
    createdAt: NOW,
    updatedAt: NOW,
    repliedAt: null,
    acceptedAt: null,
  });
  assert.deepEqual(result.state.conversations, [result.conversation]);
});

test("the responder replies and only the initiator accepts", () => {
  const started = start(emptyState());
  const replied = replyToConversation(started.state, {
    conversationId: "conversation-1",
    senderTaskId: "review-task",
    now: LATER,
  });

  assert.equal(replied.conversation.state, "replied");
  assert.equal(replied.conversation.repliedAt, LATER);
  assert.throws(
    () => acceptConversation(replied.state, {
      conversationId: "conversation-1",
      senderTaskId: "review-task",
      now: LATER,
    }),
    (error) => error?.code === "CONVERSATION_INITIATOR_REQUIRED",
  );

  const accepted = acceptConversation(replied.state, {
    conversationId: "conversation-1",
    senderTaskId: "primary-task",
    now: LATER,
  });
  assert.equal(accepted.conversation.state, "accepted");
  assert.equal(accepted.conversation.acceptedAt, LATER);
});

test("the initiator continues a replied conversation", () => {
  const started = start(emptyState());
  const replied = replyToConversation(started.state, {
    conversationId: "conversation-1",
    senderTaskId: "review-task",
    now: LATER,
  });
  const continued = continueConversation(replied.state, {
    conversationId: "conversation-1",
    senderTaskId: "primary-task",
    now: LATER,
  });

  assert.equal(continued.conversation.state, "awaiting_reply");
  assert.equal(continued.conversation.acceptedAt, null);
});

test("an accepted conversation directs the initiator to start a new one", () => {
  const started = start(emptyState());
  const replied = replyToConversation(started.state, {
    conversationId: "conversation-1",
    senderTaskId: "review-task",
    now: LATER,
  });
  const accepted = acceptConversation(replied.state, {
    conversationId: "conversation-1",
    senderTaskId: "primary-task",
    now: LATER,
  });

  assert.throws(
    () => continueConversation(accepted.state, {
      conversationId: "conversation-1",
      senderTaskId: "primary-task",
      now: LATER,
    }),
    (error) => (
      error?.code === "CONVERSATION_ACCEPTED"
      && /conversation\.mjs start --task review-task/i.test(error.message)
    ),
  );

  const next = startConversation(accepted.state, {
    conversationId: "conversation-2",
    initiatorTaskId: "primary-task",
    initiatorRole: "primary",
    responderTaskId: "review-task",
    responderRole: "review",
    now: LATER,
  });
  assert.equal(next.conversation.state, "awaiting_reply");
  assert.equal(next.state.conversations.length, 2);
});

test("rejects a new conversation when the responder already owes a reply", () => {
  const started = start(emptyState());

  assert.throws(
    () => start(started.state, {
      conversationId: "conversation-2",
      initiatorTaskId: "interviewer-task",
    }),
    (error) => (
      error?.code === "MESSAGE_TARGET_BUSY"
      && /currently owes a reply/i.test(error.message)
    ),
  );
});

test("allows a responder with an upstream obligation to initiate child work", () => {
  const parentConversation = start(emptyState(), {
    responderTaskId: "interviewer-task",
    responderRole: "interviewer",
  });
  const childConversation = startConversation(parentConversation.state, {
    conversationId: "conversation-2",
    initiatorTaskId: "interviewer-task",
    initiatorRole: "interviewer",
    responderTaskId: "review-task",
    responderRole: "review",
    now: LATER,
  });

  assert.equal(childConversation.state.conversations.length, 2);
  assert.equal(childConversation.conversation.state, "awaiting_reply");
});

test("rejects a conversation that would create a reply cycle", () => {
  const first = start(emptyState(), {
    initiatorTaskId: "task-a",
    responderTaskId: "task-b",
  });
  const second = startConversation(first.state, {
    conversationId: "conversation-2",
    initiatorTaskId: "task-b",
    initiatorRole: "review",
    responderTaskId: "task-c",
    responderRole: "interviewer",
    now: LATER,
  });

  assert.throws(
    () => startConversation(second.state, {
      conversationId: "conversation-3",
      initiatorTaskId: "task-c",
      initiatorRole: "interviewer",
      responderTaskId: "task-a",
      responderRole: "primary",
      now: LATER,
    }),
    (error) => error?.code === "CONVERSATION_CYCLE",
  );
});

test("does not require child conversations to close before an upstream reply", () => {
  const upstream = start(emptyState(), {
    responderTaskId: "interviewer-task",
    responderRole: "interviewer",
  });
  const downstream = startConversation(upstream.state, {
    conversationId: "conversation-2",
    initiatorTaskId: "interviewer-task",
    initiatorRole: "interviewer",
    responderTaskId: "review-task",
    responderRole: "review",
    now: LATER,
  });

  const replied = replyToConversation(downstream.state, {
    conversationId: "conversation-1",
    senderTaskId: "interviewer-task",
    now: LATER,
  });
  assert.equal(replied.conversation.state, "replied");
  assert.equal(
    replied.state.conversations.find(
      ({ id }) => id === "conversation-2",
    ).state,
    "awaiting_reply",
  );
});

test("validates a complete conversation collection", () => {
  const first = start(emptyState());
  const replied = replyToConversation(first.state, {
    conversationId: "conversation-1",
    senderTaskId: "review-task",
    now: LATER,
  });

  assert.deepEqual(
    validateConversationState(replied.state.conversations),
    replied.state.conversations,
  );
});

test("rejects duplicate, busy, and cyclic persisted conversations", () => {
  const first = start(emptyState()).conversation;
  assert.throws(
    () => validateConversationState([first, { ...first }]),
    (error) => error?.code === "CONVERSATION_INVALID",
  );
  assert.throws(
    () => validateConversationState([
      first,
      {
        ...first,
        id: "conversation-2",
        initiatorTaskId: "interviewer-task",
      },
    ]),
    (error) => error?.code === "MESSAGE_TARGET_BUSY",
  );
  assert.throws(
    () => validateConversationState([
      {
        ...first,
        initiatorTaskId: "task-a",
        responderTaskId: "task-b",
      },
      {
        ...first,
        id: "conversation-2",
        initiatorTaskId: "task-b",
        responderTaskId: "task-a",
      },
    ]),
    (error) => error?.code === "CONVERSATION_CYCLE",
  );
});

test("rejects malformed persisted conversation records", () => {
  const conversation = start(emptyState()).conversation;
  assert.throws(
    () => validateConversationState([{
      ...conversation,
      unexpected: true,
    }]),
    (error) => error?.code === "CONVERSATION_INVALID",
  );
  assert.throws(
    () => validateConversationState([{
      ...conversation,
      state: "replied",
      repliedAt: null,
    }]),
    (error) => error?.code === "CONVERSATION_INVALID",
  );
  assert.throws(
    () => validateConversationState([{
      ...conversation,
      updatedAt: "2026-07-29T23:59:59.000Z",
    }]),
    (error) => error?.code === "CONVERSATION_INVALID",
  );
});
