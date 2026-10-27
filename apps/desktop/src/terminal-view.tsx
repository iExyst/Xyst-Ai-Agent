import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ jobs, onRefresh }: { jobs: Array<Record<string, any>>; onRefresh: () => Promise<void> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const outputRef = useRef("");
  const pendingInputRef = useRef("");
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalJobs = jobs.filter((job) => job.kind === "process" && job.details?.pty === true);
  const firstLiveTerminal = terminalJobs.find((job) => !["completed", "failed", "cancelled"].includes(String(job.state)));
  const [terminalId, setTerminalId] = useState<string | null>(() => firstLiveTerminal?.id ?? null);
  const [workspace, setWorkspace] = useState("");
  const [status, setStatus] = useState("disconnected");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!terminalId && firstLiveTerminal) setTerminalId(String(firstLiveTerminal.id));
  }, [terminalId, firstLiveTerminal?.id]);

  useEffect(() => {
    let mounted = true;
    void window.xyst.invoke("git:current-workspace").then((result) => { if (mounted) setWorkspace(String(result?.workspace ?? "")); }).catch((reason) => { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({ cursorBlink: true, scrollback: 6000, fontSize: 12, fontFamily: "Cascadia Code, Consolas, monospace", theme: { background: "#071011", foreground: "#d6e4dc", cursor: "#89e3a5", selectionBackground: "#345746" } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(hostRef.current); terminalRef.current = terminal; fitRef.current = fit;
    const frame = requestAnimationFrame(() => fit.fit());
    const sendResize = (cols: number, rows: number) => { const id = terminalIdRef.current; if (id) void window.xyst.invoke("process:resize", { id, cols, rows }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); };
    const resizeObserver = new ResizeObserver(() => { try { fit.fit(); sendResize(terminal.cols, terminal.rows); } catch { /* Ignore layout transitions while the terminal is hidden. */ } });
    resizeObserver.observe(hostRef.current);
    const flushInput = () => {
      inputTimerRef.current = null;
      const id = terminalIdRef.current; const input = pendingInputRef.current; pendingInputRef.current = "";
      if (id && input) void window.xyst.invoke("process:input", { id, input }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    };
    const inputSubscription = terminal.onData((input) => {
      if (!terminalIdRef.current) { terminal.write("\r\nSelect or start a terminal session first.\r\n"); return; }
      pendingInputRef.current += input;
      if (pendingInputRef.current.length >= 4096) flushInput();
      else if (!inputTimerRef.current) inputTimerRef.current = setTimeout(flushInput, 35);
    });
    return () => { cancelAnimationFrame(frame); resizeObserver.disconnect(); inputSubscription.dispose(); if (inputTimerRef.current) clearTimeout(inputTimerRef.current); terminal.dispose(); terminalRef.current = null; fitRef.current = null; };
  }, []);

  useEffect(() => {
    terminalIdRef.current = terminalId;
    outputRef.current = "";
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    if (!terminalId) { setStatus("disconnected"); return; }
    setStatus("connecting");
    void window.xyst.invoke("process:resize", { id: terminalId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    let active = true;
    const refresh = async () => {
      try {
        const job = await window.xyst.invoke("process:show", { id: terminalId });
        if (!active || !job) return;
        const next = String(job.details?.stdout ?? "");
        const previous = outputRef.current;
        if (next !== previous) {
          if (next.startsWith(previous)) terminal.write(next.slice(previous.length));
          else { terminal.reset(); terminal.write(next.slice(-Math.min(next.length, 100_000))); }
          outputRef.current = next;
        }
        setStatus(String(job.state ?? "unknown"));
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 350);
    return () => { active = false; clearInterval(timer); };
  }, [terminalId]);

  const chooseWorkspace = async () => {
    setError("");
    try { const result = await window.xyst.invoke("git:pick-workspace"); if (result && !result.cancelled) setWorkspace(String(result.workspace ?? "")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const startTerminal = async () => {
    setError("");
    try {
      const terminal = terminalRef.current;
      const result = await window.xyst.invoke("terminal:start", { cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 24 });
      if (result?.id) { setTerminalId(String(result.id)); setWorkspace(String(result.cwd ?? workspace)); await onRefresh(); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const stopTerminal = async () => {
    if (!terminalId) return;
    setError("");
    try { await window.xyst.invoke("process:stop", { id: terminalId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <section className="content page-content terminal-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>INTERACTIVE SHELL</div><h1>Local <em>terminal.</em></h1><p>A real pseudoterminal with keyboard input, terminal control sequences, and resize support.</p></div><div className="changes-heading-actions"><button className="secondary-button" onClick={() => void chooseWorkspace()}>Choose directory</button><button className="primary-button" onClick={() => void startTerminal()}>New terminal <b>＋</b></button></div></div>
    <section className="panel terminal-panel"><div className="terminal-toolbar"><label>SESSION<select value={terminalId ?? ""} onChange={(event) => setTerminalId(event.target.value || null)} aria-label="Terminal session"><option value="">No terminal selected</option>{terminalJobs.map((job) => <option key={job.id} value={job.id}>{String(job.details.command ?? "shell")} · {String(job.state)} · {job.id.slice(0, 8)}</option>)}</select></label><span className={`status-pill ${["running", "queued"].includes(status) ? "status-good" : ["failed", "cancelled"].includes(status) ? "status-bad" : ""}`}>{status}</span><button className="secondary-button" disabled={!terminalId || ["completed", "failed", "cancelled"].includes(status)} onClick={() => void stopTerminal()}>Stop</button><button className="secondary-button" onClick={() => terminalRef.current?.clear()}>Clear</button></div><div className="terminal-cwd" title={workspace}>{workspace || "Application working directory"}</div><div className="terminal-screen" ref={hostRef} aria-label="Interactive terminal"/>{error && <div className="notice-line model-error" role="alert">{error}</div>}<p className="settings-foot">Terminal sessions remain as process jobs when you switch views. Their recent output is saved with the job record.</p></section>
  </section>;
}
