# Evaluation gates and result review

## Automated release gates

The Windows/Linux CI matrix runs the deterministic test suite and both offline evaluation datasets. These are blocking checks:

- The test suite must have **zero failures**. A platform-specific skip is acceptable only when the capability or operating system is absent; Linux CI enables required Bubblewrap, pidfd, and link tests so those checks cannot silently skip there.
- The routing dataset must pass **100% of cases**. A mismatch in any case fails the command and CI job.
- The routing dataset is `2026-10-24.2` and includes a narrow code-specialist model-ID tie-break for quality-oriented tool tasks when configured quality scores are equal or missing. This is a routing prior only; it does not claim measured model quality. Explicit user scores take precedence, and model profiles must be configured before a local model can be selected.
- The agent scenario dataset must pass **100% of scenarios**, including expected status, selected model, model-call count, response markers, tool order, cancellation trigger, denial count, file contents, complete fixture consumption, persisted Plan/Review state, and untrusted-tool-observation markers. Dataset `2026-10-25.2` covers multi-file edits, multi-file search that follows an imported configuration value, session-budget enforcement, cancellation between model turns, Plan and Review state (including structured-object findings with a source/test equality-boundary check), and a workspace prompt-injection attempt. These scenarios use synthetic requests and a mock provider; they do not measure live model quality.
- `pnpm eval:injection-signals` measures precision, recall, false-positive rate, exact case matches, and false-positive/negative case IDs for four report-only injection-signal categories against `eval/injection-signal-cases.json`. It emits aggregate counts and fixture IDs only; it never prints fixture text. This curated synthetic corpus measures regression behavior on known examples, not real-world detector accuracy or safety, and its metrics must not grant access, alter approvals, or suppress content.
- Formatting, lint, package validation, platform build checks, and the GUI smoke are independent required CI checks. An evaluation pass does not waive a failure in any of them.

Update `dataset_version` whenever evaluation cases change. Keep fixtures synthetic and content-safe. A new feature is not ready to become the default until its expected behavior and failure behavior are represented in the relevant dataset or an equally strict automated check.

## Live and nondeterministic evaluations

Live-model checks are opt-in and report functional results, usage, and latency. They are not CI release gates because available models, hardware, quantization, server settings, and scheduling vary. The live smoke is deliberately narrow: it verifies a bounded read/edit/read-back task and does not establish general task quality.

Do not turn a live result into a quality claim from one run. Before using a nondeterministic evaluation to promote a model, router, or prompt change:

1. Use at least **30 independent synthetic tasks per reported category** and repeat the same suite against the current baseline and candidate under recorded model IDs, server/runtime versions, generation settings, and hardware.
2. Report task success and policy violations per category, with sample counts and confidence intervals. Do not pool a safety-critical category into an overall score.
3. Require **zero policy or privacy violations**. For task success, require no category regression greater than **5 percentage points** and an overall improvement whose paired 95% confidence interval excludes zero before claiming a quality improvement. Until that evidence exists, keep the change opt-in and report-only.
4. Preserve aggregate results and failure IDs, not prompts, workspace files, responses, credentials, or raw traces. Re-run with the same recorded conditions when a result is in doubt.

`pnpm eval:compare -- baseline.json candidate.json` implements these thresholds. Each input is a versioned JSON record with only a dataset version, model ID, runtime/server/platform/hardware-class/settings identifiers, and per-task ID/category/success/policy/privacy counts. For example, each task record has exactly this shape:

```json
{
  "id": "task-001",
  "category": "tool-use",
  "success": true,
  "policy_violations": 0,
  "privacy_violations": 0
}
```

The comparator requires the same dataset, task IDs, runtime, server, platform, hardware class, and settings; model IDs may differ. It rejects extra fields so prompts and response text cannot enter the comparison format. It calculates paired task-level success deltas with 20,000 reproducible percentile-bootstrap resamples, reports overall and per-category intervals and failure IDs, and exits nonzero when any threshold fails. `--json` emits the aggregate report for archiving. Do not include serial numbers, credentials, prompts, responses, workspace paths, or raw traces in the input metadata.

## Flaky or failed evaluation procedure

CI jobs must not automatically retry a failed evaluation to produce a green result. For every failure, retain the command, platform/runtime versions, dataset version, case IDs, and sanitized failure reason. Then classify it as a product regression, invalid/stale fixture, or infrastructure failure and assign an owner.

Keep a failing deterministic case blocking while it is investigated. If an infrastructure issue makes that impossible, isolate only the affected platform check, record a tracked issue and owner, and set a removal date no more than **14 days** away; the other platform and deterministic gates remain active. Never delete a failed case or lower a threshold without updating this policy and recording the reason.

## Current commands

```sh
pnpm test
pnpm eval:routing
pnpm eval:agent
pnpm eval:injection-signals
pnpm eval:compare -- baseline.json candidate.json
pnpm smoke:browser
```

Live model checks remain separately opt-in; see the live-model instructions in the user guide.
