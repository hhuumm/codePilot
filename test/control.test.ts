import assert from "node:assert/strict";
import test from "node:test";
import { clearAgentGuidance, drainAgentGuidance, pendingAgentGuidance, queueAgentGuidance } from "../src/control.js";

test("queues and drains agent guidance in order", () => {
  const taskId = "active-task";
  clearAgentGuidance(taskId);
  queueAgentGuidance(taskId, "Keep the public API compatible");
  queueAgentGuidance(taskId, "Add a regression test");
  assert.equal(pendingAgentGuidance(taskId), 2);
  assert.deepEqual(drainAgentGuidance(taskId), ["Keep the public API compatible", "Add a regression test"]);
  assert.equal(pendingAgentGuidance(taskId), 0);
});
