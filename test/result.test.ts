import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorkerReport } from "../src/result.js";

test("accepts a version 0 worker report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codepilot-result-"));
  const path = join(directory, "report.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 0,
      status: "completed",
      summary: "Implemented the requested change.",
      claimedTests: ["npm test"],
      concerns: [],
      followUps: [],
    }),
  );

  const result = await readWorkerReport(path);
  assert.equal(result.report?.status, "completed");
  assert.deepEqual(result.warnings, []);
});

test("falls back to a warning when a report is missing", async () => {
  const result = await readWorkerReport(join(tmpdir(), `missing-${crypto.randomUUID()}.json`));
  assert.equal(result.report, undefined);
  assert.match(result.warnings[0]!, /did not produce/);
});

test("rejects an empty no-change reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codepilot-result-"));
  const path = join(directory, "report.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 0,
      status: "completed",
      summary: "No changes.",
      claimedTests: [],
      concerns: [],
      followUps: [],
      noChangeReason: "   ",
    }),
  );
  const result = await readWorkerReport(path);
  assert.equal(result.report, undefined);
  assert.match(result.warnings[0]!, /schema/);
});
