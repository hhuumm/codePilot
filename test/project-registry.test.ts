import assert from "node:assert/strict";
import test from "node:test";
import { removeProjectRegistration } from "../src/project-registry.js";

test("removes a project registration and selects a replacement when needed", () => {
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(removeProjectRegistration(projects, "b", "b"), {
    projects: [{ id: "a" }, { id: "c" }],
    activeProjectId: "a",
  });
  assert.deepEqual(removeProjectRegistration(projects, "a", "c"), {
    projects: [{ id: "a" }, { id: "b" }],
    activeProjectId: "a",
  });
});

test("refuses to remove an unknown or final project", () => {
  assert.throws(
    () => removeProjectRegistration([{ id: "a" }], "a", "missing"),
    /Project not found/,
  );
  assert.throws(
    () => removeProjectRegistration([{ id: "a" }], "a", "a"),
    /at least one/,
  );
});
