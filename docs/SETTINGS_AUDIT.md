# Xyst individual settings audit

Updated: 2026-10-30. Audit complete: functional evidence recorded for all 112 inventory entries.

All UI and runtime-override fields plus related settings actions. Model and MCP wildcards apply to each configured profile/server. Prior broad test results are leads, not per-setting proof.

Inventory: 112 entries. verified-windows-browser: 40; verified-windows-fixture: 65; verified-windows-live: 6; verified-windows: 1.

Fixture verification proves local application behavior with controlled providers. It does not assert that every external provider honors an option or that every setting combination has been tested.

| Setting or control | Status | Control | Functional evidence |
| --- | --- | --- | --- |
| default_model | verified-windows-browser | Runtime → model roles; model dock → discover/select/load | Browser checks local discovery, selection, load, safe model switch, and review/plan role controls; provider is an isolated mock. |
| review_model | verified-windows-browser | Runtime → model roles; model dock → discover/select/load | Browser checks local discovery, selection, load, safe model switch, and review/plan role controls; provider is an isolated mock. |
| plan_model | verified-windows-browser | Runtime → model roles; model dock → discover/select/load | Browser checks local discovery, selection, load, safe model switch, and review/plan role controls; provider is an isolated mock. |
| routing.enabled | verified-windows-fixture | Routing → enabled → Save settings | tests/provider.test.mjs: deterministic routing, cost/quality/speed selection, capability filters, locality, and routing disabled behavior; tests/routing-evaluation.test.mjs tests individual ratings and priority; all included in 96 passing checks |
| routing.selection | verified-windows-fixture | Routing → selection → Save settings | tests/provider.test.mjs: deterministic routing, cost/quality/speed selection, capability filters, locality, and routing disabled behavior; tests/routing-evaluation.test.mjs tests individual ratings and priority; all included in 96 passing checks |
| routing.prefer_local | verified-windows-fixture | Routing → prefer_local → Save settings | tests/provider.test.mjs: deterministic routing, cost/quality/speed selection, capability filters, locality, and routing disabled behavior; tests/routing-evaluation.test.mjs tests individual ratings and priority; all included in 96 passing checks |
| budgets.max_turns | verified-windows-fixture | Usage & limits → max_turns → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.max_input_tokens | verified-windows-fixture | Usage & limits → max_input_tokens → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.max_output_tokens | verified-windows-fixture | Usage & limits → max_output_tokens → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.max_tool_output_bytes | verified-windows-fixture | Usage & limits → max_tool_output_bytes → Save settings | tests/tools.test.mjs: limits 1/16/32/65/128/257 on real read_file output, UTF-8 validity, and restored uncapped content; failed before repair and passed afterward; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| budgets.max_session_input_tokens | verified-windows-fixture | Usage & limits → max_session_input_tokens → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.max_session_output_tokens | verified-windows-fixture | Usage & limits → max_session_output_tokens → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.recovery_summary_input_tokens | verified-windows-fixture | Usage & limits → recovery_summary_input_tokens → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.final_response_reserve_tokens | verified-windows-fixture | Usage & limits → final_response_reserve_tokens → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired missing public API snapshot field; 900-token reserve with 1000 output allowance sends only 100 working tokens and preserves a partial result; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.max_session_cost | verified-windows-fixture | Usage & limits → max_session_cost → Save settings | tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log); Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log) |
| budgets.max_daily_input_tokens | verified-windows-fixture | Usage & limits → max_daily_input_tokens → Save settings | tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| budgets.max_daily_output_tokens | verified-windows-fixture | Usage & limits → max_daily_output_tokens → Save settings | tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| budgets.max_monthly_input_tokens | verified-windows-fixture | Usage & limits → max_monthly_input_tokens → Save settings | tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| budgets.max_monthly_output_tokens | verified-windows-fixture | Usage & limits → max_monthly_output_tokens → Save settings | tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| budgets.max_daily_cost | verified-windows-fixture | Usage & limits → max_daily_cost → Save settings | tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| budgets.max_monthly_cost | verified-windows-fixture | Usage & limits → max_monthly_cost → Save settings | tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit; Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log); Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log) |
| tools.autonomy | verified-windows-browser | Runtime → Automation access | tests/tools.test.mjs and tests/agent.test.mjs: assisted approval gates tool calls; unrestricted mode changes approval/cap behavior; active-run policy event checked in browser. |
| subagents.enabled | verified-windows-fixture | Runtime → Agents; advanced limits via runtime config | tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure. |
| subagents.max_concurrent | verified-windows-fixture | Runtime → Agents; advanced limits via runtime config | tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure. |
| subagents.max_turns | verified-windows-fixture | Runtime → Agents; advanced limits via runtime config | tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure. |
| subagents.timeout_ms | verified-windows-fixture | Runtime → Agents; advanced limits via runtime config | tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure. |
| ui.sidebar_collapsed | verified-windows-browser | Appearance → sidebar_collapsed | Checkbox changes rendered layout immediately; Page.reload restores the saved collapsed layout; custom and default keyboard toggle it and persist updates; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime; Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check. |
| ui.theme | verified-windows-browser | Appearance → theme | Saved dark/light/system values change computed color-scheme; emulated OS dark/light changes are followed in system mode; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime; Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check. |
| ui.shortcuts_enabled | verified-windows-browser | Appearance → shortcuts_enabled | Disabled flag blocks real Alt+B; reenabling permits navigation while text editing suppresses actions; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime; Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check. |
| ui.shortcuts.toggle_sidebar | verified-windows-browser | Appearance → shortcuts.toggle_sidebar | Trusted Alt+B events toggle layout; clearing binding restores Ctrl+B and its action; collisions with reset defaults are rejected; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime; Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check. |
| ui.shortcuts.new_session | verified-windows-browser | Appearance → shortcuts.new_session | Trusted Alt+M opens a new conversation; clearing binding restores Ctrl+K, which focuses the new conversation composer; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime; Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check. |
| ui.shortcuts.focus_search | verified-windows-browser | Appearance → shortcuts.focus_search | Trusted Ctrl+Shift+F focuses workspace search; clearing the binding restores / and its focus action; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime; Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check. |
| memory.global_enabled | verified-windows-fixture | Data & search → Use global user memory across projects | tests/agent.test.mjs: enabled notes enter model context explicitly labeled untrusted; disabled notes are excluded; approved proposals reach later turns; Global-memory API requires authentication, rejects disabled access, and stays separate from project memory; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime |
| web_search.enabled | verified-windows-live | Runtime → Data → Live web search | tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.; scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs. |
| web_search.provider | verified-windows-live | Runtime → Data → Live web search | tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.; scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs. |
| web_search.api_key_env | verified-windows-live | Runtime → Data → Live web search | tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.; scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs. |
| web_search.api_key_secret | verified-windows-live | Runtime → Data → Live web search | tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.; scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs. |
| web_search.max_results | verified-windows-live | Runtime → Data → Live web search | tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.; scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs. |
| web_search.timeout_ms | verified-windows-live | Runtime → Data → Live web search | tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.; scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs. |
| app_data.directory | verified-windows-browser | Data & search → Data directory / Use default location | Browser seeds a global-memory note, changes location through UI, verifies copied note via export and retained original backup, then restores default and verifies the same note; Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime |
| sandbox.mode | verified-windows-browser | Runtime → Safety → Sandbox policy | tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event. |
| sandbox.tools.run_process | verified-windows-browser | Runtime → Safety → Sandbox policy | tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event. |
| sandbox.tools.run_shell_script | verified-windows-browser | Runtime → Safety → Sandbox policy | tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event. |
| sandbox.tools.start_background_process | verified-windows-browser | Runtime → Safety → Sandbox policy | tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event. |
| app_updates.mode | verified-windows-fixture | Runtime → System → Application updates | Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures. |
| app_updates.channel | verified-windows-fixture | Runtime → System → Application updates | Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures. |
| app_updates.feed_url | verified-windows-fixture | Runtime → System → Application updates | Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures. |
| app_updates.key_id | verified-windows-fixture | Runtime → System → Application updates | Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures. |
| app_updates.public_key | verified-windows-fixture | Runtime → System → Application updates | Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures. |
| models.*.provider | verified-windows-fixture | Model dock → profile editor; provider/credential config via runtime config | tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure. |
| models.*.base_url | verified-windows-fixture | Models → profile → API base URL → Save profile | tests/provider.test.mjs: configured endpoint and model reach request construction; browser approval run reaches its configured provider and expected model; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.model | verified-windows-fixture | Models → profile → Model ID → Save profile | tests/provider.test.mjs: configured endpoint and model reach request construction; browser approval run reaches its configured provider and expected model; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.api_key_env | verified-windows-fixture | Model dock → profile editor; provider/credential config via runtime config | tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure. |
| models.*.api_key_secret | verified-windows-fixture | Model dock → profile editor; provider/credential config via runtime config | tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure. |
| models.*.context_length | verified-windows-fixture | Models → profile → Manual limit / fallback · tokens → Save profile | tests/context-capacity.test.mjs: automatic loaded-host capacity, 250000 ceiling, fallback bounds, manual mode, and cancellation; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.context_mode | verified-windows-fixture | Models → profile → Context sizing → Save profile | tests/context-capacity.test.mjs: automatic loaded-host capacity, 250000 ceiling, fallback bounds, manual mode, and cancellation; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.timeout_ms | verified-windows-fixture | Model dock → profile editor; provider/credential config via runtime config | tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure. |
| models.*.retry_attempts | verified-windows | Models → profile → Same-provider retries → Save profile | tests/agent.test.mjs: agent honors retry_attempts 0/1/2 when a provider stays unavailable — actual request counts 1/2/3; passed .test-tmp/settings-retry-runtime.log; Windows desktop cargo build passed (.test-tmp/settings-retry-build.log); relaunched desktop UI reported Connected to local runtime |
| models.*.reasoning_effort | verified-windows-fixture | Models → profile → Reasoning effort → Save profile | tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.prompt_cache_enabled | verified-windows-fixture | Models → profile → Provider supports prompt cache controls → Save profile | tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.prompt_cache_key | verified-windows-fixture | Models → profile → Prompt cache key · non-sensitive identifier → Save profile | tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.prompt_cache_retention | verified-windows-fixture | Models → profile → Prompt cache retention → Save profile | tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.input_cost_per_million | verified-windows-fixture | Models → profile → Input price · USD per 1M tokens → Save profile | tests/provider.test.mjs: calculateCost asserts regular input/output rates and cached-input discount; routing checks cost strategy; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.cached_input_cost_per_million | verified-windows-fixture | Models → profile → Cached input price · USD per 1M tokens → Save profile | tests/provider.test.mjs: calculateCost asserts regular input/output rates and cached-input discount; routing checks cost strategy; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.output_cost_per_million | verified-windows-fixture | Models → profile → Output price · USD per 1M tokens → Save profile | tests/provider.test.mjs: calculateCost asserts regular input/output rates and cached-input discount; routing checks cost strategy; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.pricing_updated_at | verified-windows-fixture | Models → profile → Prices last checked (UTC) → Save profile | tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.pricing_source | verified-windows-fixture | Models → profile → Pricing source or note → Save profile | tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.capabilities_updated_at | verified-windows-fixture | Models → profile → Capabilities last checked (UTC) → Save profile | tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.capabilities_source | verified-windows-fixture | Models → profile → Capability source or note → Save profile | tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.local | verified-windows-fixture | Models → profile → Prefer as a local model → Save profile | tests/provider.test.mjs: routing capability filters and locality preference change eligible selection; image/tool constraints reject incompatible profiles; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.supports_tools | verified-windows-fixture | Models → profile → Supports tool calls → Save profile | tests/provider.test.mjs: routing capability filters and locality preference change eligible selection; image/tool constraints reject incompatible profiles; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.supports_vision | verified-windows-fixture | Models → profile → Supports image input → Save profile | tests/provider.test.mjs: routing capability filters and locality preference change eligible selection; image/tool constraints reject incompatible profiles; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.coding_strength | verified-windows-fixture | Models → profile → Coding strength · 1–10 → Save profile | tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.tool_calling_quality | verified-windows-fixture | Models → profile → Tool-call reliability · 1–10 → Save profile | tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.speed_score | verified-windows-fixture | Models → profile → Speed score · 1–10 → Save profile | tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| models.*.priority | verified-windows-fixture | Models → profile → Routing priority · 0–1000 (lower first) → Save profile | tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection; Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log |
| mcp.servers.*.enabled | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.transport | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.command | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.package_id | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.args | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.cwd | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.timeout_ms | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.env | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.url | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| mcp.servers.*.headers | verified-windows-browser | Settings → MCP servers → Add/Edit/Test/Enable; per-session selection | Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle. |
| approval_rules.tool | verified-windows-browser | Settings → Approvals; approval prompt → allow once/session/path | tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content. |
| approval_rules.scope | verified-windows-browser | Settings → Approvals; approval prompt → allow once/session/path | tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content. |
| approval_rules.pattern | verified-windows-browser | Settings → Approvals; approval prompt → allow once/session/path | tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content. |
| approval_rules.decision | verified-windows-browser | Settings → Approvals; approval prompt → allow once/session/path | tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content. |
| approval_rules.duration_ms | verified-windows-browser | Settings → Approvals; approval prompt → allow once/session/path | tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content. |
| approval_rules.revoke | verified-windows-browser | Settings → Approvals; approval prompt → allow once/session/path | tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content. |
| workspace_controls.retrieval.exclusions | verified-windows-fixture | Control API → retrieval exclusions / index rebuild | tests/semantic-index.test.mjs verifies exclusions affect indexed retrieval and a failed rebuild preserves prior index. |
| workspace_controls.retrieval.rebuild | verified-windows-fixture | Control API → retrieval exclusions / index rebuild | tests/semantic-index.test.mjs verifies exclusions affect indexed retrieval and a failed rebuild preserves prior index. |
| workspace_controls.mcp.selection | verified-windows-browser | Settings → MCP servers / session MCP tool selector | Browser asserts each control changes its actual state; expected spawn failure is distinguished from UI action failure. |
| workspace_controls.mcp.connection_test | verified-windows-browser | Settings → MCP servers / session MCP tool selector | Browser asserts each control changes its actual state; expected spawn failure is distinguished from UI action failure. |
| workspace_controls.mcp.audit_history | verified-windows-browser | Settings → MCP servers / session MCP tool selector | Browser asserts each control changes its actual state; expected spawn failure is distinguished from UI action failure. |
| workspace_controls.skills.activation | verified-windows-fixture | Skills package control API | Package service verifies signatures and version transition; browser confirms the skills panel is reachable and accurately reports empty catalog state. |
| workspace_controls.skills.rollback | verified-windows-fixture | Skills package control API | Package service verifies signatures and version transition; browser confirms the skills panel is reachable and accurately reports empty catalog state. |
| workspace_controls.skills.disable | verified-windows-fixture | Skills package control API | Package service verifies signatures and version transition; browser confirms the skills panel is reachable and accurately reports empty catalog state. |
| workspace_controls.mcp.package_activation | verified-windows-browser | Settings → signed MCP packages | Browser verifies active version and inactive state after each action against signed local fixture catalog. |
| workspace_controls.mcp.package_rollback | verified-windows-browser | Settings → signed MCP packages | Browser verifies active version and inactive state after each action against signed local fixture catalog. |
| workspace_controls.mcp.package_disable | verified-windows-browser | Settings → signed MCP packages | Browser verifies active version and inactive state after each action against signed local fixture catalog. |
| workspace_controls.packages.check_updates | verified-windows-fixture | Settings → System → Updates → Check / Download and stage | tests/extension-update-api.test.mjs checks a signed package catalog and stages the verified package inactive; the browser fixture separately activates, rolls back and disables package versions. |
| workspace_controls.app_updates.check | verified-windows-fixture | Settings → System → Updates → Check / Download and stage | Authenticated check verifies the Ed25519 signed feed and platform/channel match, persists the highest sequence, and returns only safe release metadata. |
| workspace_controls.app_updates.stage_download | verified-windows-fixture | Settings → System → Updates → Check / Download and stage | The endpoint downloads only the selected verified release, checks signed feed, SHA-256, size and platform, serves a one-time local download, and removes expired staging files. |
| workspace_controls.models.create | verified-windows-fixture | Model profile API / model dock | Profile creation is exercised via local API and discovery workflow; cleanup removes the entire isolated fixture. |
| workspace_controls.models.remove | verified-windows-browser | Model dock → profile editor → Remove profile | Browser clicks the real Remove profile UI action, confirms persisted deletion, and then verifies the API rejects removal of the profile still assigned as default and preserves that profile. |
| workspace_controls.models.connection_test | verified-windows-fixture | Model dock → connection/model discovery | Actual connection request uses fake local provider response; both error and success outcomes asserted. |
| workspace_controls.models.discover | verified-windows-browser | Model dock → Discover / Load | Browser verifies resulting model options, loaded state, selection, and local discovery request sequence. |
| workspace_controls.models.load | verified-windows-browser | Model dock → Discover / Load | Browser verifies resulting model options, loaded state, selection, and local discovery request sequence. |
| workspace_controls.credentials.store | verified-windows-fixture | Authenticated local credentials endpoint / OS secret store | Credentials resolve through provider/search fixture; secret omitted from public settings, logs and results. |

## Verification runs

- **Windows 11 — UI and runtime functional browser fixture:** Passed; headless Edge remained connected to local Xyst runtime and completed model, all 15 budget fields, routing, autonomy, sandbox, web search, memory/data location, appearance/keyboard, subagent, MCP, approvals, and package workflows. Disposable profile removal and default-profile rejection also passed. Evidence: .test-tmp/settings-model-removal-final.log. Coverage limit: Uses controlled provider/MCP/package services and isolated workspace; does not measure external provider reliability.

- **Windows — Search, approval, and subagent focused suites:** 73 passed, 0 failed, 3 symlink-capability skips across 76 tests. Evidence: tests/web-search.test.mjs, tests/web-search-settings.test.mjs, tests/approval-rules.test.mjs, tests/approval-rule-store.test.mjs, tests/approval-prompt.test.mjs, tests/subagents.test.mjs, tests/runtime-overrides.test.mjs (2026-10-30 run). Coverage limit: Symlink rejection cases skipped where Windows did not permit symlink creation.

- **Windows — Signed update and package update workflows:** 4 passed, 0 failed. Evidence: .test-tmp/settings-release-workflows.log; tests/api.test.mjs, tests/extension-update-api.test.mjs and tests/application-updates.test.mjs. Coverage limit: Uses ephemeral Ed25519 keys, signed fixture feed and fake release bytes; no production feed, signing credentials, hosting, or revocation service.

- **Ubuntu 24.04 (WSL) — Shared runtime settings and platform paths:** 178 passed, 0 failed, 0 skipped. Evidence: .test-tmp/settings-linux-functional.log; config, runtime overrides, web search, subagents, approvals, MCP and signed update suites. Coverage limit: Linux UI was not covered by this shared-runtime test batch; native WSLg Wayland launch and settings navigation are recorded in the separate Linux desktop run below.

- **Windows — Audit tool and patch hygiene:** Biome, node syntax check, JSON completeness check and git diff --check passed. Evidence: scripts/render-settings-audit.mjs output and final validation commands. Coverage limit: No product code changed in this final evidence-documentation pass; the already rebuilt/active desktop binary is the current local build.

- **Windows 11 — Sandbox, tool permissions, provider routing and model policies:** 106 passed, 0 failed, 1 Windows-specific POSIX-mode skip across 107 tests. Evidence: .test-tmp/settings-policy-routing-windows.log; tests/sandbox.test.mjs, tests/tools.test.mjs, tests/provider.test.mjs and tests/routing-evaluation.test.mjs. Coverage limit: The skipped POSIX mode-bit assertion is Linux-only; Linux sandbox and filesystem-path coverage is in the Ubuntu run.

- **Windows 11 + live loopback LM Studio + internet — Real-time web search through a local LLM:** Passed: the loaded Qwen model called the real automatic web-search provider, retrieved 3 current results, and cited 2 URLs returned by those searches. Evidence: .test-tmp/live-internet-current.log; scripts/smoke-live-internet.mjs. Coverage limit: Uses local LM Studio and keyless search sources; does not verify a paid remote model provider or Brave API key.

- **Ubuntu 24.04 WSLg (Wayland) — Native Linux desktop launch and settings UI:** Passed: built the Linux Tauri ELF, launched its native Wayland window, observed a connected local runtime, navigated Models, Routing, Agent, Safety, Appearance, Data & search, Updates and Usage & limits, and saved Dark then restored System in an isolated config. The runtime sidecar persisted ui.theme=system. Evidence: cargo build --manifest-path gui/desktop/src-tauri/Cargo.toml --locked; Linux process 6902; /tmp/xyst-linux-ui-config/config.toml.runtime.json; native UI screenshots from this turn. Coverage limit: Ubuntu ran under WSLg rather than a standalone Ubuntu installation; a production .deb/AppImage package was not built. The user-facing Windows build was left running.

- **Windows 11 — User-facing desktop left running:** Rebuilt Windows debug desktop launched and CUA confirmed the native window is open with Connected to local runtime; current PID 17892. Evidence: C:\ava ai\gui\desktop\src-tauri\target\debug\xyst-desktop.exe; local service URL 127.0.0.1:51524. Coverage limit: This confirms startup and local-runtime connection; the full settings workflows are covered by the browser fixture above.


## Repairs discovered during this audit

- **budgets.final_response_reserve_tokens**: Saved reserve omitted from public settings snapshot; editor reloaded blank. Snapshot now uses shared RUN_BUDGET_FIELDS; browser save/reset checks passed for all fifteen budget fields. Evidence: .test-tmp/settings-budgets-browser.log.

- **budgets.max_tool_output_bytes**: Truncation marker exceeded tiny byte caps and byte slicing could split UTF-8. Count marker bytes inside cap and truncate content at UTF-8 boundaries. Evidence: New real read_file regression failed at cap 1 before repair; passes at caps 1,16,32,65,128,257 after repair on Windows and Linux.

- **ui.shortcuts.***: Shared shortcut validator skipped checking restored defaults when a binding was explicitly null. Normalize reset defaults before collision checking; new regression failed before repair and passes afterward on Windows and Linux. Evidence: tests/keybindings.test.mjs; .test-tmp/settings-memory-ui-functional.log; .test-tmp/settings-shortcuts-linux.log.


## Detailed evidence

### default_model

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): selects and loads a discovered fixture profile without changing default; saves review/plan roles then restores them.

**functional**

- Browser checks local discovery, selection, load, safe model switch, and review/plan role controls; provider is an isolated mock.

**reset**

- Review/plan reset; harness removes fixture profiles.

**interactions**

- Loading a profile does not implicitly change default_model; explicit model selection remains authoritative.

**limitations**

- No live model provider account used.

### review_model

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): selects and loads a discovered fixture profile without changing default; saves review/plan roles then restores them.

**functional**

- Browser checks local discovery, selection, load, safe model switch, and review/plan role controls; provider is an isolated mock.

**reset**

- Review/plan reset; harness removes fixture profiles.

**interactions**

- Loading a profile does not implicitly change default_model; explicit model selection remains authoritative.

**limitations**

- No live model provider account used.

### plan_model

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): selects and loads a discovered fixture profile without changing default; saves review/plan roles then restores them.

**functional**

- Browser checks local discovery, selection, load, safe model switch, and review/plan role controls; provider is an isolated mock.

**reset**

- Review/plan reset; harness removes fixture profiles.

**interactions**

- Loading a profile does not implicitly change default_model; explicit model selection remains authoritative.

**limitations**

- No live model provider account used.

### routing.enabled

**persistence**

- Browser independently saves/restores enabled and prefer_local; speed, quality and cost selection values are saved and restored in .test-tmp/settings-budgets-browser.log

**functional**

- tests/provider.test.mjs: deterministic routing, cost/quality/speed selection, capability filters, locality, and routing disabled behavior; tests/routing-evaluation.test.mjs tests individual ratings and priority; all included in 96 passing checks

**reset**

- API plus reloaded controls match original state after each case

**interactions**

- Explicit requested models remain authoritative, strict fallback order is preserved, incompatible tool/image profiles are excluded

**limitations**

- Controlled profiles; no benchmark of actual remote model speed or quality

### routing.selection

**persistence**

- Browser independently saves/restores enabled and prefer_local; speed, quality and cost selection values are saved and restored in .test-tmp/settings-budgets-browser.log

**functional**

- tests/provider.test.mjs: deterministic routing, cost/quality/speed selection, capability filters, locality, and routing disabled behavior; tests/routing-evaluation.test.mjs tests individual ratings and priority; all included in 96 passing checks

**reset**

- API plus reloaded controls match original state after each case

**interactions**

- Explicit requested models remain authoritative, strict fallback order is preserved, incompatible tool/image profiles are excluded

**limitations**

- Controlled profiles; no benchmark of actual remote model speed or quality

### routing.prefer_local

**persistence**

- Browser independently saves/restores enabled and prefer_local; speed, quality and cost selection values are saved and restored in .test-tmp/settings-budgets-browser.log

**functional**

- tests/provider.test.mjs: deterministic routing, cost/quality/speed selection, capability filters, locality, and routing disabled behavior; tests/routing-evaluation.test.mjs tests individual ratings and priority; all included in 96 passing checks

**reset**

- API plus reloaded controls match original state after each case

**interactions**

- Explicit requested models remain authoritative, strict fallback order is preserved, incompatible tool/image profiles are excluded

**limitations**

- Controlled profiles; no benchmark of actual remote model speed or quality

### budgets.max_turns

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_input_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_output_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_tool_output_bytes

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/tools.test.mjs: limits 1/16/32/65/128/257 on real read_file output, UTF-8 validity, and restored uncapped content; failed before repair and passed afterward
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_session_input_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_session_output_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.recovery_summary_input_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.final_response_reserve_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired missing public API snapshot field; 900-token reserve with 1000 output allowance sends only 100 working tokens and preserves a partial result
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_session_cost

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/agent.test.mjs: focused budget workflow tests and actual provider request capture (.test-tmp/settings-agent-budget-functional.log)
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_daily_input_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_daily_output_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_monthly_input_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_monthly_output_tokens

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_daily_cost

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### budgets.max_monthly_cost

**persistence**

- verifyRuntimeSettingRoundTrips iterates every RUN_BUDGET_FIELDS entry, saves a changed value, and checks API plus reloaded control; .test-tmp/settings-budgets-browser.log passed

**functional**

- tests/usage-budget.test.mjs: individual field reserves exactly to boundary, rejects excess pending and settled usage, accepts raised limit, removes limit
- Repaired Windows desktop rebuilt and relaunched successfully; UI reported Connected to local runtime (.test-tmp/settings-budget-build.log)
- Linux WSL focused cap checks: seven passed, zero skipped (.test-tmp/settings-budget-linux.log)

**reset**

- Same browser check restores each original value, including blank override removal

**interactions**

- All shared cap cases passed; unknown-price cost rejection, concurrent reservations, daily/monthly rollover, and unrestricted autonomy bypass have explicit checks
- Focused suites: 12 agent checks; 96 budget/provider/routing/settings/inspector checks; tool+ledger run 45 passes and one platform skip

**limitations**

- Controlled runtime/provider evidence, not proof an external model will obey an output-token request

### tools.autonomy

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): saves unrestricted mode and restores original assisted setting.

**functional**

- tests/tools.test.mjs and tests/agent.test.mjs: assisted approval gates tool calls; unrestricted mode changes approval/cap behavior; active-run policy event checked in browser.

**reset**

- Original autonomy restored in isolated harness.

**interactions**

- Autonomy interacts with sandbox, tool visibility, approval prompts and budget caps.

**limitations**

- Only disposable fixture workspace and test commands used.

### subagents.enabled

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): enables subagents at concurrency 3 and disables them; tests/runtime-overrides.test.mjs verifies sidecar merge.

**functional**

- tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure.

**reset**

- Enabled reset false; fixture concurrency restored; turn/time limits bounded in fixtures.

**interactions**

- Availability gates tool exposure; concurrency gates slots; turn/runtime limits interact with parent cancellation and autonomy.

**limitations**

- max_turns/timeout_ms lack dedicated controls in this UI; verified through config/runtime overrides and agent fixtures.

### subagents.max_concurrent

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): enables subagents at concurrency 3 and disables them; tests/runtime-overrides.test.mjs verifies sidecar merge.

**functional**

- tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure.

**reset**

- Enabled reset false; fixture concurrency restored; turn/time limits bounded in fixtures.

**interactions**

- Availability gates tool exposure; concurrency gates slots; turn/runtime limits interact with parent cancellation and autonomy.

**limitations**

- max_turns/timeout_ms lack dedicated controls in this UI; verified through config/runtime overrides and agent fixtures.

### subagents.max_turns

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): enables subagents at concurrency 3 and disables them; tests/runtime-overrides.test.mjs verifies sidecar merge.

**functional**

- tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure.

**reset**

- Enabled reset false; fixture concurrency restored; turn/time limits bounded in fixtures.

**interactions**

- Availability gates tool exposure; concurrency gates slots; turn/runtime limits interact with parent cancellation and autonomy.

**limitations**

- max_turns/timeout_ms lack dedicated controls in this UI; verified through config/runtime overrides and agent fixtures.

### subagents.timeout_ms

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): enables subagents at concurrency 3 and disables them; tests/runtime-overrides.test.mjs verifies sidecar merge.

**functional**

- tests/subagents.test.mjs: isolated managed worktree, concurrency slots, turn/cost behavior, timeout abort/release; tests/agent.test.mjs checks tool exposure.

**reset**

- Enabled reset false; fixture concurrency restored; turn/time limits bounded in fixtures.

**interactions**

- Availability gates tool exposure; concurrency gates slots; turn/runtime limits interact with parent cancellation and autonomy.

**limitations**

- max_turns/timeout_ms lack dedicated controls in this UI; verified through config/runtime overrides and agent fixtures.

### ui.sidebar_collapsed

**persistence**

- Saved through UI and confirmed through API or reloaded controls; .test-tmp/settings-ui-keyboard.log passed

**functional**

- Checkbox changes rendered layout immediately; Page.reload restores the saved collapsed layout; custom and default keyboard toggle it and persist updates
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime
- Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check.

**reset**

- Browser resets shortcut bindings to defaults, restores expanded sidebar, enabled navigation, and system theme

**interactions**

- Editing text suppresses shortcuts; disabled shortcuts do not navigate; system theme follows emulated OS preference
- tests/keybindings.test.mjs: modifier matching and reset collision checks passed on Windows and Linux (.test-tmp/settings-shortcuts-linux.log)

**limitations**

- Browser keyboard events are real CDP input; native OS interception of shortcuts outside the app is not claimed

### ui.theme

**persistence**

- Saved through UI and confirmed through API or reloaded controls; .test-tmp/settings-ui-keyboard.log passed

**functional**

- Saved dark/light/system values change computed color-scheme; emulated OS dark/light changes are followed in system mode
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime
- Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check.

**reset**

- Browser resets shortcut bindings to defaults, restores expanded sidebar, enabled navigation, and system theme

**interactions**

- Editing text suppresses shortcuts; disabled shortcuts do not navigate; system theme follows emulated OS preference
- tests/keybindings.test.mjs: modifier matching and reset collision checks passed on Windows and Linux (.test-tmp/settings-shortcuts-linux.log)

**limitations**

- Browser keyboard events are real CDP input; native OS interception of shortcuts outside the app is not claimed

### ui.shortcuts_enabled

**persistence**

- Saved through UI and confirmed through API or reloaded controls; .test-tmp/settings-ui-keyboard.log passed

**functional**

- Disabled flag blocks real Alt+B; reenabling permits navigation while text editing suppresses actions
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime
- Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check.

**reset**

- Browser resets shortcut bindings to defaults, restores expanded sidebar, enabled navigation, and system theme

**interactions**

- Editing text suppresses shortcuts; disabled shortcuts do not navigate; system theme follows emulated OS preference
- tests/keybindings.test.mjs: modifier matching and reset collision checks passed on Windows and Linux (.test-tmp/settings-shortcuts-linux.log)

**limitations**

- Browser keyboard events are real CDP input; native OS interception of shortcuts outside the app is not claimed

### ui.shortcuts.toggle_sidebar

**persistence**

- Saved through UI and confirmed through API or reloaded controls; .test-tmp/settings-ui-keyboard.log passed

**functional**

- Trusted Alt+B events toggle layout; clearing binding restores Ctrl+B and its action; collisions with reset defaults are rejected
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime
- Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check.

**reset**

- Browser resets shortcut bindings to defaults, restores expanded sidebar, enabled navigation, and system theme

**interactions**

- Editing text suppresses shortcuts; disabled shortcuts do not navigate; system theme follows emulated OS preference
- tests/keybindings.test.mjs: modifier matching and reset collision checks passed on Windows and Linux (.test-tmp/settings-shortcuts-linux.log)

**limitations**

- Browser keyboard events are real CDP input; native OS interception of shortcuts outside the app is not claimed

### ui.shortcuts.new_session

**persistence**

- Saved through UI and confirmed through API or reloaded controls; .test-tmp/settings-ui-keyboard.log passed

**functional**

- Trusted Alt+M opens a new conversation; clearing binding restores Ctrl+K, which focuses the new conversation composer
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime
- Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check.

**reset**

- Browser resets shortcut bindings to defaults, restores expanded sidebar, enabled navigation, and system theme

**interactions**

- Editing text suppresses shortcuts; disabled shortcuts do not navigate; system theme follows emulated OS preference
- tests/keybindings.test.mjs: modifier matching and reset collision checks passed on Windows and Linux (.test-tmp/settings-shortcuts-linux.log)

**limitations**

- Browser keyboard events are real CDP input; native OS interception of shortcuts outside the app is not claimed

### ui.shortcuts.focus_search

**persistence**

- Saved through UI and confirmed through API or reloaded controls; .test-tmp/settings-ui-keyboard.log passed

**functional**

- Trusted Ctrl+Shift+F focuses workspace search; clearing the binding restores / and its focus action
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime
- Native Ubuntu WSLg desktop UI: changed theme to Dark, verified visual response and runtime-sidecar persistence, then restored System; isolated config removed after check.

**reset**

- Browser resets shortcut bindings to defaults, restores expanded sidebar, enabled navigation, and system theme

**interactions**

- Editing text suppresses shortcuts; disabled shortcuts do not navigate; system theme follows emulated OS preference
- tests/keybindings.test.mjs: modifier matching and reset collision checks passed on Windows and Linux (.test-tmp/settings-shortcuts-linux.log)

**limitations**

- Browser keyboard events are real CDP input; native OS interception of shortcuts outside the app is not claimed

### memory.global_enabled

**persistence**

- Browser independently toggles and restores opt-in; settings sidecar reload test passed

**functional**

- tests/agent.test.mjs: enabled notes enter model context explicitly labeled untrusted; disabled notes are excluded; approved proposals reach later turns
- Global-memory API requires authentication, rejects disabled access, and stays separate from project memory
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime

**reset**

- UI restores initial opt-in after data-location workflow; .test-tmp/settings-ui-keyboard.log

**interactions**

- Directory changes preserve notes; .test-tmp/settings-memory-ui-functional.log: ten checks passed

**limitations**

- Controlled model request inspection, not a claim that an external model follows a memory preference

### web_search.enabled

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): provider automatic → Brave → automatic; enablement toggled/restored; runtime sidecar reload verified.

**functional**

- tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.
- scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs.

**reset**

- Provider and enablement restored; disposable env/vault values are fake.

**interactions**

- Provider determines credential visibility/fallback; enablement gates web tools; result count and timeout constrain calls.

**limitations**

- Automatic keyless search was verified against live internet sources; paid Brave credentials and their account-specific rate/quota behavior were not configured.

### web_search.provider

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): provider automatic → Brave → automatic; enablement toggled/restored; runtime sidecar reload verified.

**functional**

- tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.
- scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs.

**reset**

- Provider and enablement restored; disposable env/vault values are fake.

**interactions**

- Provider determines credential visibility/fallback; enablement gates web tools; result count and timeout constrain calls.

**limitations**

- Automatic keyless search was verified against live internet sources; paid Brave credentials and their account-specific rate/quota behavior were not configured.

### web_search.api_key_env

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): provider automatic → Brave → automatic; enablement toggled/restored; runtime sidecar reload verified.

**functional**

- tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.
- scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs.

**reset**

- Provider and enablement restored; disposable env/vault values are fake.

**interactions**

- Provider determines credential visibility/fallback; enablement gates web tools; result count and timeout constrain calls.

**limitations**

- Automatic keyless search was verified against live internet sources; paid Brave credentials and their account-specific rate/quota behavior were not configured.

### web_search.api_key_secret

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): provider automatic → Brave → automatic; enablement toggled/restored; runtime sidecar reload verified.

**functional**

- tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.
- scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs.

**reset**

- Provider and enablement restored; disposable env/vault values are fake.

**interactions**

- Provider determines credential visibility/fallback; enablement gates web tools; result count and timeout constrain calls.

**limitations**

- Automatic keyless search was verified against live internet sources; paid Brave credentials and their account-specific rate/quota behavior were not configured.

### web_search.max_results

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): provider automatic → Brave → automatic; enablement toggled/restored; runtime sidecar reload verified.

**functional**

- tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.
- scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs.

**reset**

- Provider and enablement restored; disposable env/vault values are fake.

**interactions**

- Provider determines credential visibility/fallback; enablement gates web tools; result count and timeout constrain calls.

**limitations**

- Automatic keyless search was verified against live internet sources; paid Brave credentials and their account-specific rate/quota behavior were not configured.

### web_search.timeout_ms

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): provider automatic → Brave → automatic; enablement toggled/restored; runtime sidecar reload verified.

**functional**

- tests/web-search.test.mjs: keyless sources, automatic fallback, Brave env/vault credential resolution, result bounds, timeout/errors, disable gating and approval; controlled fetch fixtures.
- scripts/smoke-live-internet.mjs; .test-tmp/live-internet-current.log: a loaded local Qwen model used enabled automatic web search in a real run, retrieved three live results and cited two returned URLs.

**reset**

- Provider and enablement restored; disposable env/vault values are fake.

**interactions**

- Provider determines credential visibility/fallback; enablement gates web tools; result count and timeout constrain calls.

**limitations**

- Automatic keyless search was verified against live internet sources; paid Brave credentials and their account-specific rate/quota behavior were not configured.

### app_data.directory

**persistence**

- Browser saves absolute custom location and restores the exact default; config reload rejects relative paths

**functional**

- Browser seeds a global-memory note, changes location through UI, verifies copied note via export and retained original backup, then restores default and verifies the same note
- Windows desktop build passed (.test-tmp/settings-ui-build.log), and relaunched UI reported Connected to local runtime

**reset**

- Use default location resets path; temporary note is deleted and memory opt-in restored through UI

**interactions**

- API migration test rejects change while global-memory access or active runs are busy; preserves original backup
- Ten focused memory/UI checks passed: .test-tmp/settings-memory-ui-functional.log

**limitations**

- This directory currently controls global memory; it does not relocate project files or model weights

### sandbox.mode

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): saves sandbox mode and restores; runtime override reload and null reset checked.

**functional**

- tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event.

**reset**

- Sandbox mode restored; per-tool null removes its override.

**interactions**

- Global mode combines with per-tool overrides, autonomy, and filesystem scope to determine effective permission.

**limitations**

- Windows fixture evidence only; native Linux confinement not proven.

### sandbox.tools.run_process

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): saves sandbox mode and restores; runtime override reload and null reset checked.

**functional**

- tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event.

**reset**

- Sandbox mode restored; per-tool null removes its override.

**interactions**

- Global mode combines with per-tool overrides, autonomy, and filesystem scope to determine effective permission.

**limitations**

- Windows fixture evidence only; native Linux confinement not proven.

### sandbox.tools.run_shell_script

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): saves sandbox mode and restores; runtime override reload and null reset checked.

**functional**

- tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event.

**reset**

- Sandbox mode restored; per-tool null removes its override.

**interactions**

- Global mode combines with per-tool overrides, autonomy, and filesystem scope to determine effective permission.

**limitations**

- Windows fixture evidence only; native Linux confinement not proven.

### sandbox.tools.start_background_process

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): saves sandbox mode and restores; runtime override reload and null reset checked.

**functional**

- tests/sandbox.test.mjs, tests/tools.test.mjs and tests/agent.test.mjs: profiles affect tool visibility and path/process scopes; browser checks active-run policy event.

**reset**

- Sandbox mode restored; per-tool null removes its override.

**interactions**

- Global mode combines with per-tool overrides, autonomy, and filesystem scope to determine effective permission.

**limitations**

- Windows fixture evidence only; native Linux confinement not proven.

### app_updates.mode

**persistence**

- tests/runtime-overrides.test.mjs and tests/api.test.mjs: valid values survive reload; API hides public key and exposes fingerprint.

**functional**

- Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures.

**reset**

- Harness config removed; no production feed/key written.

**interactions**

- Mode gates checks; channel selects stream; feed and trust key identify signed source.

**limitations**

- Signed local feeds and generated ephemeral Ed25519 keys were used; no production release feed/key is configured.

### app_updates.channel

**persistence**

- tests/runtime-overrides.test.mjs and tests/api.test.mjs: valid values survive reload; API hides public key and exposes fingerprint.

**functional**

- Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures.

**reset**

- Harness config removed; no production feed/key written.

**interactions**

- Mode gates checks; channel selects stream; feed and trust key identify signed source.

**limitations**

- Signed local feeds and generated ephemeral Ed25519 keys were used; no production release feed/key is configured.

### app_updates.feed_url

**persistence**

- tests/runtime-overrides.test.mjs and tests/api.test.mjs: valid values survive reload; API hides public key and exposes fingerprint.

**functional**

- Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures.

**reset**

- Harness config removed; no production feed/key written.

**interactions**

- Mode gates checks; channel selects stream; feed and trust key identify signed source.

**limitations**

- Signed local feeds and generated ephemeral Ed25519 keys were used; no production release feed/key is configured.

### app_updates.key_id

**persistence**

- tests/runtime-overrides.test.mjs and tests/api.test.mjs: valid values survive reload; API hides public key and exposes fingerprint.

**functional**

- Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures.

**reset**

- Harness config removed; no production feed/key written.

**interactions**

- Mode gates checks; channel selects stream; feed and trust key identify signed source.

**limitations**

- Signed local feeds and generated ephemeral Ed25519 keys were used; no production release feed/key is configured.

### app_updates.public_key

**persistence**

- tests/runtime-overrides.test.mjs and tests/api.test.mjs: valid values survive reload; API hides public key and exposes fingerprint.

**functional**

- Browser checks mode/channel choices and check control; config/runtime tests validate trusted HTTPS feed, channel, key ID and Ed25519 public key; signed verifier tests validate signatures.

**reset**

- Harness config removed; no production feed/key written.

**interactions**

- Mode gates checks; channel selects stream; feed and trust key identify signed source.

**limitations**

- Signed local feeds and generated ephemeral Ed25519 keys were used; no production release feed/key is configured.

### models.*.provider

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): noncredential fields independently save/reload/reset; runtime/config tests cover provider and credential references reload.

**functional**

- tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure.

**reset**

- Isolated profile removed; only fake secret names are used.

**interactions**

- Provider selects adapter; credential and URL control auth; timeout bounds requests.

**limitations**

- No paid provider/live API credential; deterministic local/mock requests.

### models.*.base_url

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: configured endpoint and model reach request construction; browser approval run reaches its configured provider and expected model
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.model

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: configured endpoint and model reach request construction; browser approval run reaches its configured provider and expected model
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.api_key_env

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): noncredential fields independently save/reload/reset; runtime/config tests cover provider and credential references reload.

**functional**

- tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure.

**reset**

- Isolated profile removed; only fake secret names are used.

**interactions**

- Provider selects adapter; credential and URL control auth; timeout bounds requests.

**limitations**

- No paid provider/live API credential; deterministic local/mock requests.

### models.*.api_key_secret

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): noncredential fields independently save/reload/reset; runtime/config tests cover provider and credential references reload.

**functional**

- tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure.

**reset**

- Isolated profile removed; only fake secret names are used.

**interactions**

- Provider selects adapter; credential and URL control auth; timeout bounds requests.

**limitations**

- No paid provider/live API credential; deterministic local/mock requests.

### models.*.context_length

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/context-capacity.test.mjs: automatic loaded-host capacity, 250000 ceiling, fallback bounds, manual mode, and cancellation
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.context_mode

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/context-capacity.test.mjs: automatic loaded-host capacity, 250000 ceiling, fallback bounds, manual mode, and cancellation
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.timeout_ms

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): noncredential fields independently save/reload/reset; runtime/config tests cover provider and credential references reload.

**functional**

- tests/provider.test.mjs and tests/runtime-overrides.test.mjs: provider adapter selection, env/vault resolution, timeout bounds and no secret disclosure.

**reset**

- Isolated profile removed; only fake secret names are used.

**interactions**

- Provider selects adapter; credential and URL control auth; timeout bounds requests.

**limitations**

- No paid provider/live API credential; deterministic local/mock requests.

### models.*.retry_attempts

**persistence**

- scripts/smoke-browser.mjs:verifyRetrySetting — saves 2 and 0, clears to inherited/default, and checks API plus reloaded input; passed .test-tmp/settings-retry-boundaries.log

**functional**

- tests/agent.test.mjs: agent honors retry_attempts 0/1/2 when a provider stays unavailable — actual request counts 1/2/3; passed .test-tmp/settings-retry-runtime.log
- Windows desktop cargo build passed (.test-tmp/settings-retry-build.log); relaunched desktop UI reported Connected to local runtime

**reset**

- Browser clears the override and sees it omitted from API snapshot and blank in reloaded control
- Default retry behavior passed in .test-tmp/full-acceptance-fixed.log: agent retries a transient provider failure once before succeeding on the same profile

**interactions**

- Out-of-range 3 is refused by UI before saving; settings snapshot privacy and save paths passed five focused API tests

**limitations**

- Linux desktop UI verification of this individual setting remains pending

### models.*.reasoning_effort

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.prompt_cache_enabled

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.prompt_cache_key

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.prompt_cache_retention

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: reasoning/cache options reach chat and streaming requests; cache opt-out suppresses controls; actual browser workflow checks first request and defaults after profile switch
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.input_cost_per_million

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: calculateCost asserts regular input/output rates and cached-input discount; routing checks cost strategy
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.cached_input_cost_per_million

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: calculateCost asserts regular input/output rates and cached-input discount; routing checks cost strategy
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.output_cost_per_million

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: calculateCost asserts regular input/output rates and cached-input discount; routing checks cost strategy
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.pricing_updated_at

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.pricing_source

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.capabilities_updated_at

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.capabilities_source

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/model-pricing.test.mjs: metadata changes current/stale/unreviewed display and includes source notes
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.local

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: routing capability filters and locality preference change eligible selection; image/tool constraints reject incompatible profiles
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.supports_tools

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: routing capability filters and locality preference change eligible selection; image/tool constraints reject incompatible profiles
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.supports_vision

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/provider.test.mjs: routing capability filters and locality preference change eligible selection; image/tool constraints reject incompatible profiles
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.coding_strength

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.tool_calling_quality

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.speed_score

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### models.*.priority

**persistence**

- verifyModelFieldRoundTrips changes this field independently, saves, and checks the API and reloaded input; passed .test-tmp/settings-model-wire.log

**functional**

- tests/routing-evaluation.test.mjs: each rating changes selection, reset restores default, priority orders eligible fallbacks and respects explicit selection
- Relevant provider/context/pricing/config/routing run passed 95 tests: .test-tmp/settings-model-functional.log

**reset**

- Same browser test restores the exact original field value and checks original API value after reload

**interactions**

- Browser restores this field before changing the next field, then completes model switching and approved file-write workflow

**limitations**

- Controlled Windows browser/provider evidence; no claim about every external provider or Linux desktop UI

### mcp.servers.*.enabled

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.transport

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.command

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.package_id

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.args

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.cwd

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.timeout_ms

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.env

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.url

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### mcp.servers.*.headers

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): adds disposable server, checks saved config, toggles enablement, edits/cancels, and selects none/all.

**functional**

- Browser verifies expected spawn/test failure and redacted audit history; tests/mcp.test.mjs and mcp-protocol.test.mjs exercise stdio/HTTP fields, auth, timeout and tool lifecycle.

**reset**

- Added fixture server and selection removed/restored with harness.

**interactions**

- Enable gates connection; transport selects protocol; package id ties signed package; session selection limits tools.

**limitations**

- No third-party endpoint/credential; fixtures do not prove interoperability.

### approval_rules.tool

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): assisted run changes a file only after explicit approval.

**functional**

- tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content.

**reset**

- Rules confined to disposable workspace and expire or are removed.

**interactions**

- Denies override allows; scope/pattern match target; duration and revoke alter later decisions.

**limitations**

- No approval rules written to user workspace.

### approval_rules.scope

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): assisted run changes a file only after explicit approval.

**functional**

- tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content.

**reset**

- Rules confined to disposable workspace and expire or are removed.

**interactions**

- Denies override allows; scope/pattern match target; duration and revoke alter later decisions.

**limitations**

- No approval rules written to user workspace.

### approval_rules.pattern

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): assisted run changes a file only after explicit approval.

**functional**

- tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content.

**reset**

- Rules confined to disposable workspace and expire or are removed.

**interactions**

- Denies override allows; scope/pattern match target; duration and revoke alter later decisions.

**limitations**

- No approval rules written to user workspace.

### approval_rules.decision

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): assisted run changes a file only after explicit approval.

**functional**

- tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content.

**reset**

- Rules confined to disposable workspace and expire or are removed.

**interactions**

- Denies override allows; scope/pattern match target; duration and revoke alter later decisions.

**limitations**

- No approval rules written to user workspace.

### approval_rules.duration_ms

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): assisted run changes a file only after explicit approval.

**functional**

- tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content.

**reset**

- Rules confined to disposable workspace and expire or are removed.

**interactions**

- Denies override allows; scope/pattern match target; duration and revoke alter later decisions.

**limitations**

- No approval rules written to user workspace.

### approval_rules.revoke

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): assisted run changes a file only after explicit approval.

**functional**

- tests/approval-rules.test.mjs, approval-prompt.test.mjs, approval-rule-store.test.mjs: tool/path/command scope, allow/deny precedence, expiry and revocation; browser verifies reviewed hunk and written content.

**reset**

- Rules confined to disposable workspace and expire or are removed.

**interactions**

- Denies override allows; scope/pattern match target; duration and revoke alter later decisions.

**limitations**

- No approval rules written to user workspace.

### workspace_controls.retrieval.exclusions

**persistence**

- tests/api.test.mjs: adds and removes a disposable exclusion, rebuilds and clears the isolated semantic index; audit records both operations.

**functional**

- tests/semantic-index.test.mjs verifies exclusions affect indexed retrieval and a failed rebuild preserves prior index.

**reset**

- Exclusion removed and disposable index deleted by fixture cleanup.

**interactions**

- Exclusions alter rebuild contents; rebuild and clear operate on the same workspace-local semantic index.

**limitations**

- Exercised through authenticated local API and fixtures; current desktop browser does not expose these controls.

### workspace_controls.retrieval.rebuild

**persistence**

- tests/api.test.mjs: adds and removes a disposable exclusion, rebuilds and clears the isolated semantic index; audit records both operations.

**functional**

- tests/semantic-index.test.mjs verifies exclusions affect indexed retrieval and a failed rebuild preserves prior index.

**reset**

- Exclusion removed and disposable index deleted by fixture cleanup.

**interactions**

- Exclusions alter rebuild contents; rebuild and clear operate on the same workspace-local semantic index.

**limitations**

- Exercised through authenticated local API and fixtures; current desktop browser does not expose these controls.

### workspace_controls.mcp.selection

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): selects none/all, tests a deliberately missing fixture server and reads audit history with command detail redacted.

**functional**

- Browser asserts each control changes its actual state; expected spawn failure is distinguished from UI action failure.

**reset**

- Session selection returned to original; MCP server addition removed with test workspace.

**interactions**

- Selection gates tools per thread; connection test and audit are scoped to selected configured server.

**limitations**

- Test endpoint deliberately does not exist; third-party connectivity unavailable.

### workspace_controls.mcp.connection_test

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): selects none/all, tests a deliberately missing fixture server and reads audit history with command detail redacted.

**functional**

- Browser asserts each control changes its actual state; expected spawn failure is distinguished from UI action failure.

**reset**

- Session selection returned to original; MCP server addition removed with test workspace.

**interactions**

- Selection gates tools per thread; connection test and audit are scoped to selected configured server.

**limitations**

- Test endpoint deliberately does not exist; third-party connectivity unavailable.

### workspace_controls.mcp.audit_history

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): selects none/all, tests a deliberately missing fixture server and reads audit history with command detail redacted.

**functional**

- Browser asserts each control changes its actual state; expected spawn failure is distinguished from UI action failure.

**reset**

- Session selection returned to original; MCP server addition removed with test workspace.

**interactions**

- Selection gates tools per thread; connection test and audit are scoped to selected configured server.

**limitations**

- Test endpoint deliberately does not exist; third-party connectivity unavailable.

### workspace_controls.skills.activation

**persistence**

- tests/api.test.mjs: signed package API activates, rolls back and disables a local fixture release.

**functional**

- Package service verifies signatures and version transition; browser confirms the skills panel is reachable and accurately reports empty catalog state.

**reset**

- Package data isolated to test workspace.

**interactions**

- Activation establishes trusted instructions; rollback returns prior package; disable prevents injection into agent context.

**limitations**

- No trusted skill update feed is configured in the user build, so only local package fixtures were exercised.

### workspace_controls.skills.rollback

**persistence**

- tests/api.test.mjs: signed package API activates, rolls back and disables a local fixture release.

**functional**

- Package service verifies signatures and version transition; browser confirms the skills panel is reachable and accurately reports empty catalog state.

**reset**

- Package data isolated to test workspace.

**interactions**

- Activation establishes trusted instructions; rollback returns prior package; disable prevents injection into agent context.

**limitations**

- No trusted skill update feed is configured in the user build, so only local package fixtures were exercised.

### workspace_controls.skills.disable

**persistence**

- tests/api.test.mjs: signed package API activates, rolls back and disables a local fixture release.

**functional**

- Package service verifies signatures and version transition; browser confirms the skills panel is reachable and accurately reports empty catalog state.

**reset**

- Package data isolated to test workspace.

**interactions**

- Activation establishes trusted instructions; rollback returns prior package; disable prevents injection into agent context.

**limitations**

- No trusted skill update feed is configured in the user build, so only local package fixtures were exercised.

### workspace_controls.mcp.package_activation

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): activates v1.0.0, upgrades v1.1.0, rolls back, then disables package.

**functional**

- Browser verifies active version and inactive state after each action against signed local fixture catalog.

**reset**

- Fixture package state discarded with isolated service.

**interactions**

- Activation changes server version; rollback returns previous version; disable removes it from active server list.

**limitations**

- Local signed fixture package only.

### workspace_controls.mcp.package_rollback

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): activates v1.0.0, upgrades v1.1.0, rolls back, then disables package.

**functional**

- Browser verifies active version and inactive state after each action against signed local fixture catalog.

**reset**

- Fixture package state discarded with isolated service.

**interactions**

- Activation changes server version; rollback returns previous version; disable removes it from active server list.

**limitations**

- Local signed fixture package only.

### workspace_controls.mcp.package_disable

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): activates v1.0.0, upgrades v1.1.0, rolls back, then disables package.

**functional**

- Browser verifies active version and inactive state after each action against signed local fixture catalog.

**reset**

- Fixture package state discarded with isolated service.

**interactions**

- Activation changes server version; rollback returns previous version; disable removes it from active server list.

**limitations**

- Local signed fixture package only.

### workspace_controls.packages.check_updates

**persistence**

- tests/api.test.mjs and tests/application-updates.test.mjs; .test-tmp/settings-release-workflows.log (2026-10-30): Ed25519 signed local feed is checked, platform-matched release is verified, signed artifact hash/size are checked, a one-time download is staged and consumed, and stale/unauthenticated requests are rejected.

**functional**

- tests/extension-update-api.test.mjs checks a signed package catalog and stages the verified package inactive; the browser fixture separately activates, rolls back and disables package versions.

**reset**

- Update sequence and staged artifacts are scoped to disposable test directories and cleaned on shutdown.

**interactions**

- A trusted feed, matching key ID, release channel, signature, platform and sequence are required before download; update staging never auto-installs.

**limitations**

- Only signed local fixtures were used. No production feed, signing credential, hosting or revocation service is configured, by user choice.

### workspace_controls.app_updates.check

**persistence**

- tests/api.test.mjs and tests/application-updates.test.mjs; .test-tmp/settings-release-workflows.log (2026-10-30): Ed25519 signed local feed is checked, platform-matched release is verified, signed artifact hash/size are checked, a one-time download is staged and consumed, and stale/unauthenticated requests are rejected.

**functional**

- Authenticated check verifies the Ed25519 signed feed and platform/channel match, persists the highest sequence, and returns only safe release metadata.

**reset**

- Update sequence and staged artifacts are scoped to disposable test directories and cleaned on shutdown.

**interactions**

- A trusted feed, matching key ID, release channel, signature, platform and sequence are required before download; update staging never auto-installs.

**limitations**

- Only signed local fixtures were used. No production feed, signing credential, hosting or revocation service is configured, by user choice.

### workspace_controls.app_updates.stage_download

**persistence**

- tests/api.test.mjs and tests/application-updates.test.mjs; .test-tmp/settings-release-workflows.log (2026-10-30): Ed25519 signed local feed is checked, platform-matched release is verified, signed artifact hash/size are checked, a one-time download is staged and consumed, and stale/unauthenticated requests are rejected.

**functional**

- The endpoint downloads only the selected verified release, checks signed feed, SHA-256, size and platform, serves a one-time local download, and removes expired staging files.

**reset**

- Update sequence and staged artifacts are scoped to disposable test directories and cleaned on shutdown.

**interactions**

- A trusted feed, matching key ID, release channel, signature, platform and sequence are required before download; update staging never auto-installs.

**limitations**

- Only signed local fixtures were used. No production feed, signing credential, hosting or revocation service is configured, by user choice.

### workspace_controls.models.create

**persistence**

- tests/api.test.mjs: creates a profile in runtime settings and verifies config reload; browser connects a discovered model and verifies new profile, and reuses an existing profile without duplication.

**functional**

- Profile creation is exercised via local API and discovery workflow; cleanup removes the entire isolated fixture.

**reset**

- Fixture model profiles removed with harness.

**interactions**

- Connecting a discovered ID adds a profile; selecting an already configured ID reuses the profile.

**limitations**

- Profile removal is not exercised by the main browser run; see pending status retained until a dedicated deletion action is verified.

### workspace_controls.models.remove

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-model-removal-final.log (2026-10-30): a disposable nondefault profile is removed; authenticated settings reload no longer contains it.

**functional**

- Browser clicks the real Remove profile UI action, confirms persisted deletion, and then verifies the API rejects removal of the profile still assigned as default and preserves that profile.

**reset**

- Disposable model profile and browser/service fixture are deleted during harness cleanup.

**interactions**

- Deleting an unreferenced profile succeeds; deleting the configured default fails without altering settings.

**limitations**

- No user profile was modified; both profiles were isolated fixtures.

### workspace_controls.models.connection_test

**persistence**

- tests/api.test.mjs: model-list connection returns bounded IDs, redacts credentials/errors, handles provider errors/timeouts and cancellation; browser verifies fixture model discovery and safe connection.

**functional**

- Actual connection request uses fake local provider response; both error and success outcomes asserted.

**reset**

- No model data persisted outside isolated config.

**interactions**

- Model profile auth and timeout govern connection; discovery cancellation aborts provider request.

**limitations**

- Deterministic local provider only; no third-party model account.

### workspace_controls.models.discover

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): discovers multiple fake local models, proves discovery alone does not load, loads an existing profile and Load & use creates/selects expected fixture profile.

**functional**

- Browser verifies resulting model options, loaded state, selection, and local discovery request sequence.

**reset**

- Discovery/load state belongs to disposable mock LM Studio; harness exits.

**interactions**

- Discovery does not implicitly load; configured-profile load does not silently change default model; Load & use selects intended model.

**limitations**

- Local model manager is an HTTP fixture, not a live LM Studio device.

### workspace_controls.models.load

**persistence**

- scripts/smoke-browser.mjs; .test-tmp/settings-full-browser.log (2026-10-30): discovers multiple fake local models, proves discovery alone does not load, loads an existing profile and Load & use creates/selects expected fixture profile.

**functional**

- Browser verifies resulting model options, loaded state, selection, and local discovery request sequence.

**reset**

- Discovery/load state belongs to disposable mock LM Studio; harness exits.

**interactions**

- Discovery does not implicitly load; configured-profile load does not silently change default model; Load & use selects intended model.

**limitations**

- Local model manager is an HTTP fixture, not a live LM Studio device.

### workspace_controls.credentials.store

**persistence**

- tests/api.test.mjs and tests/api-client.test.mjs: stores/deletes fake secret without returning or auditing it; tests/discovery-secrets.test.mjs checks real session keyring where available.

**functional**

- Credentials resolve through provider/search fixture; secret omitted from public settings, logs and results.

**reset**

- Disposable fake credential deleted by tests; no user credential touched.

**interactions**

- Credential reference selects vault entry and provider receives value only for authenticated request.

**limitations**

- No actual provider secret was stored; Linux keyring tests require a session keyring.
