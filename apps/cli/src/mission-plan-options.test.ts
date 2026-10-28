import assert from "node:assert/strict";
import test from "node:test";
import { MISSION_PLAN_USAGE, parseMissionPlanArguments } from "./mission-plan-options.js";

test("mission plan arguments retain the project scope and other explicit options", () => {
  assert.deepEqual(parseMissionPlanArguments(["Prepare", "a", "review", "--project", "repo-17", "--name", "Review", "--workspace", "C:/work/repo", "--model", "local/reviewer", "--max-concurrency", "3"]), {
    objective: "Prepare a review", projectId: "repo-17", name: "Review", workspace: "C:/work/repo", model: "local/reviewer", maxConcurrency: 3
  });
});

test("mission plan arguments reject missing option values and empty objectives", () => {
  assert.throws(() => parseMissionPlanArguments(["--project"]), /--project requires a value/);
  assert.throws(() => parseMissionPlanArguments(["--project", "repo-17"]), (error: unknown) => error instanceof Error && error.message === MISSION_PLAN_USAGE);
});
