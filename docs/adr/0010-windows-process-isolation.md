# ADR 0010: Windows process isolation

- Status: Accepted prototype; native AppContainer helper is wired to the shared Node process adapter and packaged in Windows desktop resources. Live Windows tests cover streams, stdin, timeout, sibling-write denial, loopback denial, and ACL recovery. Broader security validation remains open.
- Date: 2026-10-21

## Context

The product needs a Windows boundary for commands that matches the Linux requirement: workspace-scoped filesystem access, no network by default, and process-tree cleanup. A restricted token or Job Object alone does not establish all three boundaries. Required mode reaches the Windows backend through a fixed packaged helper; it still fails closed if that helper is missing or any required control fails.

Windows AppContainer provides a supported process identity and denies access to protected resources unless both the user/group and AppContainer principals grant access through the resource DACL. An AppContainer without network capability is isolated from network access. Microsoft documents the launch path through `CreateAppContainerProfile`, `STARTUPINFOEX`, `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, and `CreateProcess`.

## Decision

Implement the baseline Windows backend with a native helper using the stable AppContainer process-creation APIs. Keep the backend unavailable and fail closed if any required API, ACL operation, or containment verification fails.

For each isolated invocation, the helper will:

1. Validate and canonicalize the workspace path, reject a drive root or UNC root, open the directory without following a reparse point, and capture its stable file identity. Create a fresh, unpredictable AppContainer identity for this invocation.
2. Create an AppContainer profile with no capabilities. In particular, do not grant `internetClient`, `internetClientServer`, or `privateNetworkClientServer`.
3. Before changing permissions, write a durable recovery record containing the workspace file identity, exact package SID, and exact ACE to a private user-data location. Add a narrowly scoped, inheritable package-SID access entry to the opened workspace root. Windows propagates inheritable ACEs to existing descendants when `SetSecurityInfo` changes the DACL; the implementation must detect and reject reparse points and external hard links and fail closed if propagation cannot establish access for the selected tree. Preserve the existing DACL. On cleanup, re-read the current DACL and remove only this invocation's ACE so concurrent user ACL edits are preserved. Fail closed when the DACL cannot be safely updated or restored. Recover stale records before allowing another required-sandbox invocation. AppContainer's documented system-file and runtime access remains available; user data outside the workspace must remain inaccessible, and no host paths receive write access.
4. Launch the requested executable with an explicit environment and startup attributes. Do not inherit arbitrary handles or environment variables. Keep stdin/stdout/stderr forwarding limited to the required pipes. Include the kill-on-close Job Object in `PROC_THREAD_ATTRIBUTE_JOB_LIST` so process creation assigns the job atomically; there must be no crash window with a suspended child outside the job.
5. Resume the process only after Windows has created it inside the configured job, so descendants inherit the job and are terminated with the invocation.
6. Wait for completion, terminate the job on cancellation or timeout, verify it is empty, remove this invocation's ACE, delete the recovery record, and remove the temporary AppContainer profile. A failed cleanup is reported as a sandbox failure and retained for recovery; required mode stays unavailable until recovery succeeds.

The native helper is shipped inside the desktop runtime resource tree and resolved from fixed application resource locations. `PATH`, the current directory, project files, and environment-provided executable paths are not trusted helper-discovery sources. The shared Node process adapter communicates through a bounded versioned JSON request/response over the helper's standard streams. The helper passes only child stdin/stdout/stderr handles to the command. Disable Win32k system calls for this headless process backend; the separate desktop-control tool stays unavailable in required mode.

Required isolation remains incompatible with Unrestricted autonomy, machine-wide file access, MCP child processes, and desktop control. Those capabilities require host access by design. The sandbox must not be presented as active when the helper is missing, untrusted, or fails to establish every required control.

## Prototype status

The Windows AppContainer helper creates a temporary no-capability profile, uses `GetAppContainerFolderPath` for private `TEMP`/`TMP`, and builds an explicit child environment. It validates the selected workspace, rejects reparse points and files with multiple hard links, and grants an inheritable package-SID ACL entry on the workspace root. The kill-on-close Job Object is assigned atomically through `PROC_THREAD_ATTRIBUTE_JOB_LIST` before the suspended child resumes. The helper's versioned JSON protocol bounds request size, argument count, and stdin; the shared Node adapter validates helper responses, preserves separate stdout/stderr, applies its output cap, forwards cancellation by terminating the helper, and fails closed if the packaged helper is missing. The desktop build compiles the helper and stages it in the packaged runtime resource directory. Native tests cover streams, bounded output, stdin, timeout, pre-resume and active cancellation, and ACL recovery. An end-to-end Windows test runs through the Node adapter and confirms stdout/stderr separation, stdin forwarding, sibling-directory write denial, loopback connection denial, and timeout reporting. Before the ACL change, the host writes a durable recovery record under `%LOCALAPPDATA%\Xyst AI Assistant\SandboxRecovery`; startup recovery validates profile/SID and workspace identity, revokes only that SID's ACE from the current DACL, removes the profile, then deletes the record. Force-kill transition testing, complete-tree escape validation, arbitrary descendant propagation, helper code-integrity review, supported-edition coverage, and independent security review remain open. Required mode remains a prototype rather than a production security boundary.

## Alternatives considered

- **Restricted token only:** Does not provide the required network boundary or scoped filesystem allowlist.
- **Job Object only:** Controls process lifetime and selected resource limits but does not constrain filesystem or network access.
- **Experimental `Experimental_CreateProcessInSandbox`:** The current Microsoft documentation labels these APIs experimental, specifies a Windows 11 minimum, and requires a versioned FlatBuffer sandbox specification. It is not the compatibility baseline. Re-evaluate after the API and schema are stable and supported by the product's pinned Windows matrix.
- **Windows Sandbox / Hyper-V VM:** Requires optional Windows features and heavier setup, does not provide a generally available no-admin path, and complicates synchronous workspace writes.

## Validation required before implementation is called complete

- Windows integration tests must prove that commands can read/write the selected workspace, cannot access sensitive user-data siblings or write to host paths outside the workspace/AppContainer-private temp, cannot reach loopback or external network endpoints, and cannot access other processes or the interactive desktop. Required system executable/runtime reads are expected and must be documented.
- Test traversal, symlink and junction escapes, hard links, alternate data streams, UNC paths, nested mounts/reparse points, protected DACLs, concurrent invocations, process spawning, timeout, cancellation, helper crash, and ACL restoration after every failure path.
- Test recovery after forcibly terminating the helper at each journal/ACL/profile transition; recovery must preserve concurrent DACL changes and refuse to continue when the target identity no longer matches.
- Verify AppContainer and Job Object membership for the launched process and descendants; verify no process remains after completion, timeout, cancellation, or parent termination.
- Run the suite on each supported Windows edition and architecture. Obtain an independent review before describing this backend as a production security boundary.

## References

- [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- [UpdateProcThreadAttribute and PROC_THREAD_ATTRIBUTE_JOB_LIST](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [MoveFileExW and MOVEFILE_WRITE_THROUGH](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
- [Create Process In Sandbox APIs](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
