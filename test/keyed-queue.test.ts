import assert from "node:assert/strict";
import test from "node:test";
import { KeyedSerialQueue } from "../src/keyed-queue.js";

test("serializes work for one project while allowing different projects to overlap", async () => {
  const queue = new KeyedSerialQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

  const first = queue.run("project-a", async () => {
    events.push("a1:start");
    await firstGate;
    events.push("a1:end");
  });
  const second = queue.run("project-a", async () => {
    events.push("a2:start");
  });
  const other = queue.run("project-b", async () => {
    events.push("b:start");
  });

  await other;
  assert.deepEqual(events, ["a1:start", "b:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1:start", "b:start", "a1:end", "a2:start"]);
});

test("continues a project queue after a failed operation", async () => {
  const queue = new KeyedSerialQueue();
  await assert.rejects(queue.run("project", async () => { throw new Error("failed"); }));
  assert.equal(await queue.run("project", async () => "recovered"), "recovered");
});
