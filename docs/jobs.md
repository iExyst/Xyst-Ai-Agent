# Job inspection

The CLI and desktop Jobs view list durable work records stored in Xyst's SQLite database. The desktop Jobs view can launch a direct-argv process, send stdin, close stdin, and stop its process tree. Current job kinds include GitHub-trigger deliveries, mission runs, model downloads, and detached CLI process jobs. Process jobs keep their argv in a private spec table; normal job inspection shows the command, working directory, bounded output, exit status, and timestamps.

```sh
xyst jobs list
xyst jobs list --limit 100
xyst jobs show <job-id>
xyst process start [--interactive] [--pty] [--cols N --rows N] [--cwd PATH] -- <executable> [args...]
xyst process list [--limit 1-200]
xyst process show <job-id>
xyst process stop <job-id>
xyst process input <job-id> <text>
xyst process end-input <job-id>
xyst process resize <job-id> <columns> <rows>
```

`jobs list` is ordered by most recent update and accepts limits from 1 to 200. `jobs show` accepts the Xyst record ID; for model downloads it also accepts the LM Studio download job ID. Mission runs expose their mission ID, trigger type, schedule time, heartbeat, and error. Model download records expose the repository revision, quantization, artifact details, and linked LM Studio job ID. GitHub-trigger records expose their saved delivery details and queue state.

Process creation requires both `backgroundJobs` and `externalActions` capabilities; restricted profiles must allow both and the executable. Stop requests are persisted and terminate the process tree. Output is bounded to the most recent 100,000 characters per stream and secret patterns are redacted.

Use `--interactive` to keep a process's stdin pipe open, then send text with `process input` or close it with `process end-input`. Use `--pty` for a real pseudo-terminal with terminal input, control sequences, and a configurable size. PTY size defaults to 80×24; `--cols` accepts 20–500 and `--rows` accepts 5–200. Resize a running PTY with `process resize`. On Windows, Xyst uses ConPTY; on Linux, it uses a native PTY. The desktop Terminal view renders these sessions with xterm.js, forwards keyboard input, and resizes the PTY with the view. CLI process jobs remain detached and durable: inspect output with `process show`, send input with `process input`, and resize with `process resize`. The separate `--interactive` pipe mode does not provide terminal line discipline or terminal-size behavior.

Use `mission show`, `mission resume`, `mission cancel`, `hf download-status`, and `hf verify-download` for the corresponding other operational actions.
