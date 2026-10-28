# GitHub integration support

Xyst uses GitHub's REST API with version header `2026-03-10`. The provider reads the fine-grained token's actual permissions from the API behavior and includes `X-Accepted-GitHub-Permissions` details when GitHub rejects an operation. It does not claim scopes that the token does not have.

GitHub Enterprise Server is supported by setting `integrations.github.apiBaseUrl` to its HTTPS REST API base (commonly `https://HOST/api/v3`). Set it with `xyst config set integrations.github.apiBaseUrl '"https://github.example.com/api/v3"' global`, or use Settings → GitHub Server in the desktop. Xyst sends GitHub credentials only to the selected API host; HTTPS Git clone/fetch/push credentials are scoped to that same host. Leave the setting unset to use GitHub.com. Enterprise instances should be checked against their own GitHub API version and permissions policy before production use.

## Authentication

- Personal token: run `xyst credential set github personal-token`; input is hidden in an interactive terminal or read from stdin.
- GitHub App installation token: store `app-id`, `installation-id`, and `private-key` under service `github-app`. Xyst signs a short-lived app JWT and requests an installation token; the installation token is cached only in memory until shortly before expiry.
- `xyst github auth status` checks the authenticated user or App identity. Public repository reads can work without authentication, subject to GitHub rate limits.
- Token permission and organization policy are authoritative. For fine-grained personal access tokens, start with repository metadata and the specific `Issues`, `Pull requests`, `Contents`, `Checks`, or `Actions` permissions needed for the requested operation. Workflow dispatch needs Actions write access; creating a PR needs Pull requests write plus repository/branch access.
- An HTTP 401 invalidates Xyst's cached GitHub identity and App installation token, then explains how to check authentication and replace or verify credentials. Requests are not automatically replayed. GitHub may return HTTP 404 when a private resource is not accessible to the current account; Xyst tells the user to check both existence and repository access rather than claiming the resource is absent.

## Supported operations

The runtime supports repository lookup/search, issue lists and details, issue labels (list, add, replace, and remove), issue comments, pull request lists and diffs, listing inline pull request review comments, creating single-line or multi-line inline review comments, replying to a top-level review comment, PR creation and updates (title, body, base, and open/closed state), commit check runs, workflow run lists and bounded text logs, release and Actions artifact lists and downloads, workflow dispatch, and mission-authorized PR merge. Writes require the GitHub write toggle and the active profile's external-action permission. Workflow log archives are limited to 25 MiB; returned log text is limited to 50 files, 2 MiB per file, 10 MiB total, and 100,000 characters per file, with common credentials redacted. Release and Actions artifact archives are limited to 100 MiB, require a new destination path allowed by the active filesystem profile, and are never written over an existing file. Artifact downloads also depend on GitHub permissions and artifact expiry. New review comments require the head commit SHA, changed file path, and line range from the current pull request diff; GitHub rejects stale or invalid coordinates. Replies require a top-level comment ID. Agent Git tools can clone into a new destination, create a branch, stage selected paths, commit selected paths without including unrelated staged changes, fetch without merging, and push without force. Clone/fetch/push use direct `git` argv execution and require the active access profile to allow Git, network access where applicable, and external actions. The runtime records these mutations in the external-action journal so uncertain outcomes are not silently repeated.

For `https://github.com` remotes, the existing Xyst personal token or GitHub App installation token is passed to Git through a temporary host-scoped `http.extraHeader` environment configuration. It is not written into `.git/config` or the remote URL. Git's documented `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` environment mechanism supplies this temporary setting ([Git configuration documentation](https://git-scm.com/docs/git-config)). HTTPS GitHub fetches require `integrations.github.enabled`; pushes also require `integrations.github.writeEnabled`. SSH remotes use the user's configured SSH key or agent. Other Git hosts use the user's existing Git credential helper. GitHub App and personal tokens do not authenticate SSH remotes. Git terminal prompting is disabled for network Git operations so unattended jobs fail instead of hanging for interactive input.

CLI examples, run from the target repository:

```sh
xyst github review-comments owner/repo 123
xyst github review-comment owner/repo 123 <head-commit-sha> src/file.ts 42 "Explain the issue on this changed line"
xyst github review-reply owner/repo 123 456 "Thanks, this is fixed"
xyst github labels owner/repo 123
xyst github label-add owner/repo 123 bug,triage
xyst github label-replace owner/repo 123 bug,ready
xyst github label-remove owner/repo 123 "needs review"
xyst github pr-update owner/repo 123 title "Clarify implementation"
xyst github workflow-runs owner/repo main
xyst github workflow-logs owner/repo 123456789
xyst github releases owner/repo
xyst github artifacts owner/repo
xyst github download-release owner/repo 12345 ./release-asset.zip
xyst github download-artifact owner/repo 67890 ./actions-artifact.zip
xyst git clone https://github.com/owner/repo.git ../repo
xyst git branch feature/issue-123
xyst git add src/file.ts README.md
xyst git commit -m "Implement issue 123" -- src/file.ts README.md
xyst git fetch origin main
xyst git push origin feature/issue-123
```

`git clone` also accepts a local `file:` URL. Clone destination parents must exist and the final destination must be new. Fetch does not merge or rebase. Commit requires an explicit path list; new files must be staged first. Push targets `HEAD` at the named branch and never force-pushes. Server-side branch protections still apply.

The desktop GitHub view can search accessible repositories, list issues or pull requests by state, and open an item on `github.com`. Configure authentication and enable the integration from the CLI first. The desktop browser view performs reads only; write actions continue to use the runtime's explicit integration and access checks.

Webhook requests use HMAC-SHA256 signature verification, a 1 MiB body limit, the delivery ID, and a durable deduplication table. Before enqueueing a sender-authored event, Xyst resolves its own actor from the authenticated personal-token user or GitHub App slug (`slug[bot]`). Self-authored events are marked processed without triggering missions; if Xyst cannot identify its actor, webhook handling fails so an event cannot start a self-trigger loop. Consumers receive the original payload as untrusted task input and enqueue work idempotently by delivery ID. `xyst mission daemon --webhook` opts into the built-in receiver; it defaults to loopback at `127.0.0.1:8787/github/webhook`. Put an HTTPS reverse proxy or tunnel in front of it for GitHub delivery. `xyst mission service install --webhook` persists the same listener options in the Windows or Linux background runner. Binding to another interface requires explicit command-line configuration and the active profile's network and integration capabilities. No listener starts unless `--webhook` is supplied.

## Verification state

- `xyst github auth status` reports the authenticated Xyst identity `iExyst`. Using a private validation repository, the Xyst agent read issue [#1](https://github.com/iExyst/xyst-agent-validation/issues/1), updated `README.md`, and ran `node scripts/verify-readme.mjs` successfully. The Xyst CLI pushed the branch and opened [PR #2](https://github.com/iExyst/xyst-agent-validation/pull/2); its `readme-smoke` check completed with `success`. On 2026-10-25, the latest PR workflow run (`40127560570`) for head `b870ca480f60e09a45107adc1aec01567700776f` also completed successfully. The PR remains open and unmerged.
- The CLI retrieved workflow run `40127560570` and its `readme-smoke` logs from the same private repository. Release and Actions artifact listing both returned empty arrays, so binary downloads have deterministic tests but no live asset to exercise. A live Ministral 3 agent call used the `github_issue_labels` tool on issue #1 and read its empty label list. Label and PR mutation endpoints have fixture tests; no live mutation was performed. Windows and Ubuntu 24.04 WSL pass typecheck, 82 runtime tests, and 10 CLI tests for the current implementation.
- Local clone/branch/stage/commit/fetch/push behavior, restricted-profile enforcement, GitHub setting gates, temporary host-scoped token configuration, and enterprise API base validation have deterministic tests on Windows and Ubuntu 24.04 WSL. Review-comment API requests are fixture-tested for single-line and multi-line payloads, replies, write permissions, and current-head commit SHA validation. The endpoints and `start_line`/`start_side` parameters follow the current [GitHub REST documentation](https://docs.github.com/en/rest/pulls/comments). Enterprise remotes are rejected before network access when the GitHub integration toggle is off. The configured Enterprise host path is implemented but has not been tested against a live GHES instance. Workflow dispatch, merge, and branch protection behavior remain unverified against live repositories.
- Authorized workflow dispatch now has a REST fixture test for the encoded workflow endpoint, requested ref, string inputs, and disabled/restricted write-policy rejection. This verifies Xyst's local request and policy behavior; it does not claim a live workflow dispatch against an external repository. Live dispatch, merge, branch-protection behavior, and GHES interoperability remain unverified.
- GitHub App installation authentication has deterministic current-source coverage for RS256 JWT header/claims/signature, installation-token exchange and reuse, App identity resolution, authenticated repository access, malformed expiry rejection, and network-error wrapping. This does not replace a live GitHub App installation check; no App credentials are available in the current acceptance environment.

## References

- [REST API authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28)
- [Fine-grained token permissions by endpoint](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Pull request REST endpoints](https://docs.github.com/en/rest/pulls/pulls)
- [Issue REST endpoints](https://docs.github.com/en/rest/issues)
- [Issue label REST endpoints](https://docs.github.com/en/rest/issues/labels)
- [Actions artifact REST endpoints](https://docs.github.com/en/rest/actions/artifacts)
- [Release asset REST endpoints](https://docs.github.com/en/rest/releases/assets)
- [GitHub App REST endpoints](https://docs.github.com/en/rest/apps/apps)
- [REST API troubleshooting and accepted permissions](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
