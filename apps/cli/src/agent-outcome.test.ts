import assert from "node:assert/strict";
import test from "node:test";
import { agentOutcomeNotice } from "./agent-outcome.js";

test("completed agent run needs no recovery notice", () => {
  assert.equal(agentOutcomeNotice("completed", "session-1"), undefined);
});

test("unverified agent output warns and gives inspect and resume commands", () => {
  const notice = agentOutcomeNotice("unverified", "session-1");
  assert.match(notice ?? "", /completion criteria were not verified/i);
  assert.match(notice ?? "", /xyst session calls session-1/);
  assert.match(notice ?? "", /xyst agent resume session-1/);
});

test("turn-limit outcome is visible and resumable even without model text", () => {
  const notice = agentOutcomeNotice("limit", "session-2");
  assert.match(notice ?? "", /turn limit reached/i);
  assert.match(notice ?? "", /session is saved/i);
  assert.match(notice ?? "", /xyst agent resume session-2/);
});

test("cancelled agent run explains that its saved session can be inspected or resumed", () => {
  const notice = agentOutcomeNotice("cancelled", "session-3");
  assert.match(notice ?? "", /cancelled/i);
  assert.match(notice ?? "", /xyst session calls session-3/);
  assert.match(notice ?? "", /xyst agent resume session-3/);
});
