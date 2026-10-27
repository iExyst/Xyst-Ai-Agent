import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoalStore } from '../src/goals/store.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new GoalStore(workspaceRoot);
const title = 'Qualify Xyst for a secure, supportable release';
const details =
  'Follow BUILD_PLAN.md in priority order: establish a reviewable baseline and supported release scope; obtain an independent security review and resolve critical/high findings; pass clean hosted Windows and Ubuntu CI plus native platform acceptance; close only the product gaps those gates or real workflows expose; then sign, lifecycle-verify, and publish supported artifacts. Keep Xyst classified as a development build until the release gates are evidenced.';

const goals = await store.list();
const existing = goals.find((goal) => goal.title === title);
if (existing) {
  console.log(JSON.stringify({ status: 'already_exists', goal_id: existing.id, title }));
} else {
  const goal = await store.add(title, details);
  await store.addProgress(
    goal.id,
    'Created prioritized execution plan in BUILD_PLAN.md. Current first action: capture a reviewable source baseline and schedule independent security review plus clean hosted Windows/Ubuntu CI.',
    'BUILD_PLAN.md',
  );
  console.log(JSON.stringify({ status: 'created', goal_id: goal.id, title }));
}
