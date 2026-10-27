import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./appearance.css";
import { scopedSettingKeys, settingApplyWhen, type DesktopSettingScope } from "./setting-keys.js";
const TerminalView = lazy(() => import("./terminal-view.js").then((module) => ({ default: module.TerminalView })));

type View = "overview" | "sessions" | "missions" | "agents" | "jobs" | "terminal" | "models" | "github" | "settings" | "memory" | "changes";
type LayoutPanel = "navigation" | "centerPanel" | "contextPanel" | "activityPanel" | "overviewStats" | "taskPanel" | "modelPanel" | "missionPanel" | "statusBar";
type LayoutPreferences = Record<LayoutPanel, boolean>;
const defaultLayoutPreferences: LayoutPreferences = { navigation: true, centerPanel: true, contextPanel: true, activityPanel: true, overviewStats: true, taskPanel: true, modelPanel: true, missionPanel: true, statusBar: true };
const layoutPanelOptions: Array<{ key: LayoutPanel; title: string; description: string }> = [
  { key: "navigation", title: "Left navigation", description: "Workspace pages and access profile." },
  { key: "centerPanel", title: "Center workspace", description: "Current page and main work area." },
  { key: "contextPanel", title: "Right context panel", description: "Current view, model, profile, and quick links." },
  { key: "activityPanel", title: "Bottom execution panel", description: "Recent persisted jobs and terminal access." },
  { key: "overviewStats", title: "Overview status cards", description: "Mission, model, session, and runtime counts." },
  { key: "taskPanel", title: "Task composer and activity", description: "Start tasks and inspect recent agent events." },
  { key: "modelPanel", title: "Overview model status", description: "Show LM Studio connection and loaded model." },
  { key: "missionPanel", title: "Recent missions", description: "Show saved workflows on Overview." },
  { key: "statusBar", title: "Runtime status bar", description: "Show runtime readiness and shared state path." }
];
const viewOptions: Array<[View, string]> = [["overview", "Overview"], ["sessions", "Sessions"], ["missions", "Missions"], ["agents", "Agents"], ["jobs", "Jobs"], ["terminal", "Terminal"], ["models", "Model dock"], ["github", "GitHub bridge"], ["changes", "Changes"], ["memory", "Memory"], ["settings", "Settings"]];
type Snapshot = { status: Record<string, any>; updateState?: Record<string, any>; browser?: Record<string, any>; systemResources?: Record<string, any>; sessions: unknown[]; memories: Array<Record<string, any>>; missions: Array<Record<string, any>>; agents: Array<Record<string, any>>; jobs: Array<Record<string, any>>; models: Array<Record<string, any>>; downloads: Array<Record<string, any>>; modelsError?: string; settings?: Record<string, any> };
type AgentEvent = { type?: string; event?: string; data?: Record<string, any>; sessionId?: string; at?: string };
type LMLoadForm = { contextLength: string; ttlSeconds: string; evalBatchSize: string; numExperts: string; flashAttention: "default" | "on" | "off"; kvCacheGpu: "default" | "on" | "off"; gpuOffload: string; draftMode: "default" | "mtp" | "simple"; draftModel: string; draftMaxTokens: string; draftMinTokens: string; draftMinProbability: string };
const emptyLoadForm: LMLoadForm = { contextLength: "", ttlSeconds: "", evalBatchSize: "", numExperts: "", flashAttention: "default", kvCacheGpu: "default", gpuOffload: "default", draftMode: "default", draftModel: "", draftMaxTokens: "", draftMinTokens: "", draftMinProbability: "" };

function isFinishedWorkState(state: unknown): boolean {
  return ["completed", "succeeded", "failed"].includes(String(state ?? "").toLowerCase());
}

function readLayoutPreferences(): LayoutPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem("xyst.layout") ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.keys(defaultLayoutPreferences).map((key) => [key, typeof parsed[key] === "boolean" ? parsed[key] : defaultLayoutPreferences[key as LayoutPanel]])) as LayoutPreferences;
  } catch { return { ...defaultLayoutPreferences }; }
}

function finishedWorkKeys(snapshot: Snapshot): string[] {
  const groups: Array<[string, Array<Record<string, any>>]> = [["mission", snapshot.missions ?? []], ["job", snapshot.jobs ?? []]];
  return groups.flatMap(([kind, entries]) => entries.filter((entry) => entry.id != null && isFinishedWorkState(entry.status ?? entry.state)).map((entry) => `${kind}:${String(entry.id)}`));
}

function playFinishedWorkChime(context: AudioContext): void {
  if (context.state !== "running") return;
  const start = context.currentTime;
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(660, start);
  oscillator.frequency.setValueAtTime(880, start + 0.09);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(0.022, start + 0.015);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
  oscillator.connect(volume);
  volume.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.25);
}

function RobotMark() {
  return <svg className="robot-mark" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4v6M21 4h6"/><rect x="7" y="12" width="34" height="27" rx="10"/><path d="M14 23h7m6 0h7M18 31h12M4 23v7m40-7v7"/><circle cx="17.5" cy="22" r="2"/><circle cx="30.5" cy="22" r="2"/></svg>;
}

function renderMessageContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part: any) => part?.type === "text" ? String(part.text ?? "") : part?.type === "image_url" ? "[Image attachment]" : JSON.stringify(part)).join("\n");
}

function prettyStoredJson(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value ?? null, null, 2) ?? String(value ?? "");
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

function UpdateSettings({ settings, state, onSetting, onAction }: { settings: Record<string, any>; state: Record<string, any>; onSetting: (key: string, value: unknown) => Promise<void>; onAction: (action: string) => Promise<any> }) {
  const [feedUrl, setFeedUrl] = useState(String(settings?.updatesFeedUrl?.value ?? ""));
  useEffect(() => setFeedUrl(String(settings?.updatesFeedUrl?.value ?? "")), [settings?.updatesFeedUrl?.value]);
  const status = String(state?.status ?? "idle");
  const available = status === "available";
  const downloaded = status === "downloaded";
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">RELEASE MANAGEMENT</div><h2>Application updates</h2></div></div><ToggleRow title="Check for Xyst updates" description="Check this configured HTTPS feed when the desktop starts. Checks also require the global network setting and active profile to allow network access." value={Boolean(settings?.updatesEnabled?.value)} source={settings?.updatesEnabled?.source} onChange={(enabled) => void onSetting("updates.enabled", enabled)}/><ToggleRow title="Download updates automatically" description="Download an available update in the background. Installation always requires an explicit restart action." value={Boolean(settings?.updatesAutomaticDownload?.value)} source={settings?.updatesAutomaticDownload?.source} onChange={(enabled) => void onSetting("updates.autoDownload", enabled)}/><label className="model-select-label">HTTPS UPDATE FEED<input aria-label="Xyst update feed URL" type="url" placeholder="https://releases.example.com/xyst/" value={feedUrl} onChange={(event) => setFeedUrl(event.target.value)}/><small className="setting-source">Effective source · {settings?.updatesFeedUrl?.source ?? "not configured"}</small></label><div className="memory-actions"><button className="secondary-button" disabled={!feedUrl.trim()} onClick={() => void onSetting("updates.feedUrl", feedUrl.trim() || null)}>Save feed URL</button><button className="secondary-button" disabled={!settings?.updatesEnabled?.value || !feedUrl.trim() || status === "checking" || status === "downloading"} onClick={() => void onAction("updates:check")}>Check now</button>{available && !settings?.updatesAutomaticDownload?.value && <button className="primary-button" onClick={() => void onAction("updates:download")}>Download {state.version}</button>}{downloaded && <button className="primary-button" onClick={() => { if (window.confirm(`Install Xyst ${String(state.version ?? "update")} and restart the desktop now?`)) void onAction("updates:install"); }}>Install and restart</button>}</div><p className="settings-foot" role="status">{status === "idle" ? `Xyst ${state.currentVersion ?? ""} · no update check yet.` : status === "checking" ? "Checking the configured update feed…" : status === "up-to-date" ? `Xyst ${state.currentVersion ?? ""} is current.` : status === "available" ? `Xyst ${state.version} is available${state.total ? ` · ${Math.ceil(Number(state.total) / 1024 / 1024)} MiB` : ""}.` : status === "downloading" ? `Downloading Xyst ${state.version ?? "update"} · ${Math.round(Number(state.percent ?? 0))}%` : status === "downloaded" ? `Xyst ${state.version} is downloaded and ready to install.` : status === "error" ? `Update error: ${String(state.error ?? "Unknown update error")}` : `Update status: ${status}.`}</p>{status === "downloading" && <progress className="update-progress" max={100} value={Number(state.percent ?? 0)} aria-label="Xyst update download progress"/>}<p className="settings-foot">Set an HTTPS feed from a trusted release host. It must provide electron-builder generic-feed metadata (`latest.yml`) and the matching platform artifact. Auto-install on quit is disabled; updates install only after you choose Restart and install.</p></section>;
}

function OcrLanguageSettings({ setting, onSave }: { setting: { value: unknown; source: string }; onSave: (languages: string[]) => Promise<unknown> }) {
  const [value, setValue] = useState(Array.isArray(setting.value) ? setting.value.join(", ") : "eng");
  const [message, setMessage] = useState("");
  useEffect(() => setValue(Array.isArray(setting.value) ? setting.value.join(", ") : "eng"), [setting.value]);
  const languages = value.split(",").map((item) => item.trim()).filter(Boolean);
  const valid = languages.length > 0 && languages.length <= 4 && languages.every((item) => ["eng", "fra", "deu", "spa"].includes(item)) && new Set(languages).size === languages.length;
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">DOCUMENTS</div><h2>PDF OCR languages</h2></div></div><label className="model-select-label">LANGUAGE CODES<input aria-label="PDF OCR languages" value={value} onChange={(event) => setValue(event.target.value)} placeholder="eng, fra"/><small className="setting-source">Use eng, fra, deu, and/or spa · effective source: {setting.source}</small></label><button className="secondary-button" disabled={!valid} onClick={() => { setMessage(""); void onSave(languages).then(() => setMessage("OCR language setting saved.")).catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }}>Save OCR languages</button><p className="settings-foot" role="status">{message || "Applies to scanned PDF extraction in office_read and attached PDFs. Language data is bundled, so OCR stays offline."}</p></section>;
}

function OfficeRendererSettings({ setting, onSave }: { setting: { value: unknown; source: string }; onSave: (executable: string) => Promise<unknown> }) {
  const [executable, setExecutable] = useState(String(setting.value ?? ""));
  const [message, setMessage] = useState("");
  useEffect(() => setExecutable(String(setting.value ?? "")), [setting.value]);
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">DOCUMENTS</div><h2>Office document preview</h2></div></div><label className="model-select-label">LIBREOFFICE EXECUTABLE<input aria-label="LibreOffice executable path" value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder={navigator.platform.startsWith("Win") ? "C:\\Program Files\\LibreOffice\\program\\soffice.com" : "soffice"}/><small className="setting-source">Leave blank to use soffice from PATH · effective source: {setting.source}</small></label><button className="secondary-button" onClick={() => { setMessage(""); void onSave(executable.trim()).then(() => setMessage("Office renderer setting saved.")).catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }}>Save renderer path</button><p className="settings-foot" role="status">{message || "DOCX, XLSX, and PPTX page previews use an installed LibreOffice command-line renderer. It is optional and is not bundled with Xyst."}</p></section>;
}

function GitHubServerSettings({ setting, onSave }: { setting: { value: unknown; source: string }; onSave: (value: string | null) => Promise<void> }) {
  const [apiBaseUrl, setApiBaseUrl] = useState(String(setting.value ?? ""));
  useEffect(() => setApiBaseUrl(String(setting.value ?? "")), [setting.value]);
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">GITHUB SERVER</div><h2>GitHub Enterprise</h2></div></div><label className="model-select-label">ENTERPRISE API BASE URL<input aria-label="GitHub Enterprise API base URL" type="url" placeholder="https://github.example.com/api/v3" value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)}/><small className="setting-source">Leave empty to use GitHub.com · effective source: {setting.source}</small></label><button className="secondary-button" onClick={() => void onSave(apiBaseUrl.trim() || null)}>Save server URL</button><p className="settings-foot">Use the enterprise REST API base URL over HTTPS. Xyst sends GitHub credentials only to this configured host and scopes Git transport credentials to matching HTTPS remotes.</p></section>;
}

function McpSettings({ enabled, servers, onSave }: { enabled: { value: unknown; source: string }; servers: { value: unknown; source: string }; onSave: (value: { enabled: boolean; servers: unknown }) => Promise<unknown> }) {
  const [active, setActive] = useState(Boolean(enabled.value));
  const serializedServers = JSON.stringify(servers.value ?? [], null, 2);
  const [json, setJson] = useState(serializedServers);
  const [message, setMessage] = useState("");
  useEffect(() => { setActive(Boolean(enabled.value)); setJson(serializedServers); setMessage(""); }, [enabled.value, serializedServers]);
  const save = async () => {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) throw new Error("MCP server configuration must be a JSON array.");
      const result = await onSave({ enabled: active, servers: parsed });
      if (result !== undefined) setMessage(`Saved ${parsed.length} server definition${parsed.length === 1 ? "" : "s"}. Applies to the next agent task.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">MODEL CONTEXT PROTOCOL</div><h2>MCP servers</h2></div></div><ToggleRow title="Use configured MCP servers" description="Allow agent tasks to connect to the configured servers, subject to the access profile and per-server transport permissions." value={active} source={enabled.source} onChange={setActive}/><label className="model-select-label">SERVER DEFINITIONS · JSON<textarea aria-label="MCP server definitions JSON" rows={12} spellCheck={false} value={json} onChange={(event) => setJson(event.target.value)} /></label><small className="setting-source">Effective server list source · {servers.source}</small><button className="secondary-button" onClick={() => void save()}>Save MCP settings</button>{message && <p className="settings-foot" role="status">{message}</p>}<p className="settings-foot">Use stdio, streamable HTTP, or legacy SSE. For OAuth, set `"oauth": true` on an HTTPS HTTP server and run `xyst mcp auth login &lt;server-id&gt;` in the CLI. Store other secrets in the credential vault and enter only credential references such as a bearer token reference. Plain secret environment values are rejected.</p></section>;
}

function NativeChatMcpSettings({ enabled, integrations, onSave }: { enabled: { value: unknown; source: string }; integrations: { value: unknown; source: string }; onSave: (value: { enabled: boolean; integrations: unknown }) => Promise<unknown> }) {
  const [active, setActive] = useState(Boolean(enabled.value));
  const serialized = JSON.stringify(integrations.value ?? [], null, 2);
  const [json, setJson] = useState(serialized);
  const [message, setMessage] = useState("");
  useEffect(() => { setActive(Boolean(enabled.value)); setJson(serialized); setMessage(""); }, [enabled.value, serialized]);
  const save = async () => {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) throw new Error("Native chat MCP integrations must be a JSON array.");
      const result = await onSave({ enabled: active, integrations: parsed });
      if (result !== undefined) setMessage(`Saved ${parsed.length} native integration definition${parsed.length === 1 ? "" : "s"}. Applies to the next direct LM Studio chat.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">LM STUDIO NATIVE MCP</div><h2>Direct chat integrations</h2></div></div><ToggleRow title="Attach integrations to direct LM Studio chat" description="Add these plugins or ephemeral servers to every `lm ask` or `lm stream` request unless that command supplies --integration-file." value={active} source={enabled.source} onChange={setActive}/><label className="model-select-label">PLUGIN AND EPHEMERAL SERVER DEFINITIONS · JSON<textarea aria-label="Native LM Studio integration definitions JSON" rows={10} spellCheck={false} value={json} onChange={(event) => setJson(event.target.value)} /></label><small className="setting-source">Effective definition source · {integrations.source}</small><button className="secondary-button" onClick={() => void save()}>Save native chat integrations</button>{message && <p className="settings-foot" role="status">{message}</p>}<p className="settings-foot">Use `credential_headers` references for ephemeral server secrets, never plain values. These tools execute inside LM Studio and require its server permission plus Xyst network, integrations, and external-actions access; Xyst per-tool approval must be off for this route.</p></section>;
}

function InferenceSettings({ settings, onApply }: { settings: Record<string, { value: unknown; source: string }>; onApply: (values: Record<string, string>) => Promise<void> }) {
  const [draft, setDraft] = useState({ temperature: "", maxTokens: "", requestTimeoutSeconds: "600", topP: "", topK: "", repeatPenalty: "", presencePenalty: "", frequencyPenalty: "", stopSequences: "", reasoning: "" });
  useEffect(() => setDraft({ temperature: settings?.temperature?.value == null ? "" : String(settings.temperature.value), maxTokens: settings?.maxTokens?.value == null ? "" : String(settings.maxTokens.value), requestTimeoutSeconds: String(settings?.requestTimeoutSeconds?.value ?? 600), topP: settings?.topP?.value == null ? "" : String(settings.topP.value), topK: settings?.topK?.value == null ? "" : String(settings.topK.value), repeatPenalty: settings?.repeatPenalty?.value == null ? "" : String(settings.repeatPenalty.value), presencePenalty: settings?.presencePenalty?.value == null ? "" : String(settings.presencePenalty.value), frequencyPenalty: settings?.frequencyPenalty?.value == null ? "" : String(settings.frequencyPenalty.value), stopSequences: settings?.stopSequences?.value == null ? "" : typeof settings.stopSequences.value === "string" ? settings.stopSequences.value : JSON.stringify(settings.stopSequences.value), reasoning: settings?.reasoning?.value == null ? "" : String(settings.reasoning.value) }), [settings?.temperature?.value, settings?.maxTokens?.value, settings?.requestTimeoutSeconds?.value, settings?.topP?.value, settings?.topK?.value, settings?.repeatPenalty?.value, settings?.presencePenalty?.value, settings?.frequencyPenalty?.value, settings?.stopSequences?.value, settings?.reasoning?.value]);
  const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">GENERATION</div><h2>Inference parameters</h2></div></div><p className="settings-foot">Blank values preserve LM Studio defaults. Stop sequences accept one string or a JSON array. Reasoning applies to direct native chat requests; tool-agent runs use the model default. The request timeout cancels stalled inference and response streams. Each configured value shows its effective source.</p><div className="inference-grid"><label>Temperature<input aria-label="Inference temperature" type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => update("temperature", event.target.value)}/><small>{settings?.temperature?.source ?? "runtime default"}</small></label><label>Maximum output tokens<input aria-label="Maximum output tokens" type="number" min="1" max="1000000" step="1" value={draft.maxTokens} onChange={(event) => update("maxTokens", event.target.value)}/><small>{settings?.maxTokens?.source ?? "runtime default"}</small></label><label>Request timeout (seconds)<input aria-label="Inference request timeout seconds" type="number" min="5" max="3600" step="1" value={draft.requestTimeoutSeconds} onChange={(event) => update("requestTimeoutSeconds", event.target.value)}/><small>{settings?.requestTimeoutSeconds?.source ?? "runtime default · 600"}</small></label><label>Top-p<input aria-label="Inference top-p" type="number" min="0" max="1" step="0.05" value={draft.topP} onChange={(event) => update("topP", event.target.value)}/><small>{settings?.topP?.source ?? "runtime default"}</small></label><label>Top-k<input aria-label="Inference top-k" type="number" min="1" max="1000" step="1" value={draft.topK} onChange={(event) => update("topK", event.target.value)}/><small>{settings?.topK?.source ?? "runtime default"}</small></label><label>Repeat penalty<input aria-label="Inference repeat penalty" type="number" min="0.1" max="5" step="0.1" value={draft.repeatPenalty} onChange={(event) => update("repeatPenalty", event.target.value)}/><small>{settings?.repeatPenalty?.source ?? "runtime default"}</small></label><label>Presence penalty<input aria-label="Presence penalty" type="number" min="-2" max="2" step="0.1" value={draft.presencePenalty} onChange={(event) => update("presencePenalty", event.target.value)}/><small>{settings?.presencePenalty?.source ?? "runtime default"}</small></label><label>Frequency penalty<input aria-label="Frequency penalty" type="number" min="-2" max="2" step="0.1" value={draft.frequencyPenalty} onChange={(event) => update("frequencyPenalty", event.target.value)}/><small>{settings?.frequencyPenalty?.source ?? "runtime default"}</small></label><label>Stop sequences<input aria-label="Stop sequences" value={draft.stopSequences} placeholder='["END"]' onChange={(event) => update("stopSequences", event.target.value)}/><small>{settings?.stopSequences?.source ?? "runtime default"}</small></label><label>Reasoning level<select aria-label="Reasoning level" value={draft.reasoning} onChange={(event) => update("reasoning", event.target.value)}><option value="">LM Studio default</option>{["off", "low", "medium", "high", "on"].map((level) => <option key={level} value={level}>{level}</option>)}</select><small>{settings?.reasoning?.source ?? "runtime default"}</small></label></div><button className="secondary-button full-button" onClick={() => void onApply(draft)}>Apply inference parameters</button></section>;
}

function ParallelReadSettings({ setting, onChange }: { setting?: { value: unknown; source: string }; onChange: (value: number) => void }) {
  const value = Number(setting?.value ?? 4);
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">TOOL EXECUTION</div><h2>Parallel read calls</h2></div></div><p className="settings-foot">Independent file and Git reads in one model response can run together. Mutations and external actions stay ordered. This limit applies to the next agent run and supports the usual scoped configuration overrides.</p><label className="model-select-label">MAXIMUM SIMULTANEOUS READS<select aria-label="Maximum parallel read tool calls" value={value} onChange={(event) => onChange(Number(event.target.value))}>{[1,2,3,4,6,8].map((count) => <option key={count} value={count}>{count} read calls</option>)}</select><small className="setting-source">Effective source · {setting?.source ?? "runtime default · 4"}</small></label></section>;
}

function App() {
  const [view, setView] = useState<View>("overview");
  const [layout, setLayout] = useState<LayoutPreferences>(readLayoutPreferences);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: {}, sessions: [], memories: [], missions: [], agents: [], jobs: [], models: [], downloads: [] });
  const [runtimeState, setRuntimeState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [updateState, setUpdateState] = useState<Record<string, any>>({ status: "idle" });
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [objective, setObjective] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [missionJson, setMissionJson] = useState("");
  const [missionObjective, setMissionObjective] = useState("");
  const [missionTemplateId, setMissionTemplateId] = useState("issue-to-pr");
  const [missionTemplates, setMissionTemplates] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [selectedSession, setSelectedSession] = useState<Record<string, any> | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Array<Record<string, any>>>([]);
  const [sessionCalls, setSessionCalls] = useState<Array<Record<string, any>>>([]);
  const [sessionArtifacts, setSessionArtifacts] = useState<Array<Record<string, any>>>([]);
  const [sessionReply, setSessionReply] = useState("");
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryKind, setMemoryKind] = useState<"preference" | "note" | "inferred">("note");
  const [memoryContent, setMemoryContent] = useState("");
  const [editingMemory, setEditingMemory] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [embeddingModelChoice, setEmbeddingModelChoice] = useState("");
  const [memoryIndexMessage, setMemoryIndexMessage] = useState("");
  const [modelTab, setModelTab] = useState<"local" | "huggingface">("local");
  const [hfQuery, setHfQuery] = useState("");
  const [hfResults, setHfResults] = useState<Array<Record<string, any>>>([]);
  const [hfRecommendations, setHfRecommendations] = useState<Array<Record<string, any>>>([]);
  const [quantizations, setQuantizations] = useState<Record<string, string>>({});
  const [modelLoadForms, setModelLoadForms] = useState<Record<string, LMLoadForm>>({});
  const [modelLoadNotes, setModelLoadNotes] = useState<Record<string, string>>({});
  const [showMissionEditor, setShowMissionEditor] = useState(false);
  const [processCommand, setProcessCommand] = useState("");
  const [processArgs, setProcessArgs] = useState("[]");
  const [processCwd, setProcessCwd] = useState("");
  const [processInteractive, setProcessInteractive] = useState(false);
  const [processInputDrafts, setProcessInputDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const activeAgentRunId = useRef<string | null>(null);
  const [error, setErrorMessage] = useState("");
  const [errorDetails, setErrorDetails] = useState("");
  const setError = (message: string) => { setErrorMessage(message); setErrorDetails(""); };
  const [prefs, setPrefs] = useState({ reducedMotion: false, highContrast: false, largeText: false, decorativeEffects: true, animations: true, robotPresentation: true, soundAlerts: false, accent: "green" });
  const prefsRef = useRef(prefs);
  const previousSnapshot = useRef<Snapshot | null>(null);
  const alertedFinishedWork = useRef(new Set<string>());
  const audioContext = useRef<AudioContext | null>(null);
  prefsRef.current = prefs;

  const activateSoundAlerts = () => {
    try {
      audioContext.current ??= new AudioContext();
      if (audioContext.current.state === "suspended") void audioContext.current.resume().catch(() => undefined);
    } catch { /* Audio alerts remain unavailable if the platform has no Web Audio support. */ }
  };

  const refresh = async () => {
    try {
      const current = await window.xyst.snapshot();
      const previous = previousSnapshot.current;
      const finishedKeys = finishedWorkKeys(current);
      const hasUnseenFinishedWork = finishedKeys.some((key) => !alertedFinishedWork.current.has(key));
      if (previous && prefsRef.current.soundAlerts && hasUnseenFinishedWork && audioContext.current) playFinishedWorkChime(audioContext.current);
      for (const key of finishedKeys) alertedFinishedWork.current.add(key);
      previousSnapshot.current = current;
      setSnapshot(current);
      setRuntimeState(current.status?.runtime === "ready" && current.status?.database === "ready" ? "ready" : "unavailable");
      if (current.updateState) setUpdateState(current.updateState);
      if (typeof current.status?.error === "string") {
        setErrorMessage(current.status.error);
        setErrorDetails(typeof current.status.errorDetails === "string" ? current.status.errorDetails : "");
      } else setError("");
    }
    catch (reason) {
      setRuntimeState("unavailable");
      const detail = reason instanceof Error ? reason.message : String(reason);
      if (/SQLITE_(?:CORRUPT|NOTADB)|database disk image is malformed|file is not a database/i.test(detail)) {
        setErrorMessage("Xyst couldn't open its local database. Run `xyst database check` for a read-only integrity report, then restore from a known-good backup if needed.");
        setErrorDetails(detail);
      } else setError(detail);
    }
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 8_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => window.xyst.onAgentEvent((event) => setEvents((current) => [...current.slice(-79), event])), []);
  useEffect(() => window.xyst.onUpdaterEvent((event) => setUpdateState(event)), []);
  useEffect(() => {
    const read = (key: string, fallback = false) => localStorage.getItem(`xyst.${key}`) === null ? fallback : localStorage.getItem(`xyst.${key}`) === "true";
    const accent = localStorage.getItem("xyst.accent") ?? "green";
    const stored = { reducedMotion: read("reducedMotion"), highContrast: read("highContrast"), largeText: read("largeText"), decorativeEffects: read("decorativeEffects", true), animations: read("animations", true), robotPresentation: read("robotPresentation", true), soundAlerts: read("soundAlerts"), accent: ["green", "cyan", "violet"].includes(accent) ? accent : "green" };
    setPrefs(stored);
    for (const [key, value] of Object.entries(stored)) document.documentElement.dataset[key] = String(value);
  }, []);
  useEffect(() => {
    const resumeAudioOnInteraction = () => { if (prefsRef.current.soundAlerts) activateSoundAlerts(); };
    window.addEventListener("pointerdown", resumeAudioOnInteraction);
    window.addEventListener("keydown", resumeAudioOnInteraction);
    return () => {
      window.removeEventListener("pointerdown", resumeAudioOnInteraction);
      window.removeEventListener("keydown", resumeAudioOnInteraction);
      if (audioContext.current && audioContext.current.state !== "closed") void audioContext.current.close().catch(() => undefined);
      audioContext.current = null;
    };
  }, []);

  const models = snapshot.models ?? []; const missions = snapshot.missions ?? []; const agents = snapshot.agents ?? []; const downloads = snapshot.downloads ?? []; const jobs = snapshot.jobs ?? [];
  const embeddingModels = models.filter((model) => model.type === "embedding");
  const configuredEmbeddingModel = String(snapshot.settings?.embeddingModel?.value ?? "");
  const selectedEmbeddingModel = embeddingModelChoice === "__auto__" ? "" : embeddingModelChoice || configuredEmbeddingModel;
  const embeddingModelSelectValue = selectedEmbeddingModel || "__auto__";
  const memoryBudgetBytes = snapshot.settings?.memoryBudgetBytes?.value;
  const memoryBudgetChoice = memoryBudgetBytes == null ? "auto" : String(memoryBudgetBytes);
  const maxResourceMemory = Number(snapshot.settings?.maxMemoryBytes ?? 0);
  const memoryBudgetChoices = [0.25, 0.5, 1, 2, 4, 8, 16, 32].filter((gib) => gib * 1024 ** 3 <= maxResourceMemory);
  const maxConcurrencyChoice = String(snapshot.settings?.maxConcurrency?.value ?? 8);
  const loadedCount = useMemo(() => models.reduce((count, model) => count + (Array.isArray(model.loaded_instances) ? model.loaded_instances.length : 0), 0), [models]);
  const call = async (action: string, payload?: unknown) => {
    setBusy(true); setError("");
    try { const result = await window.xyst.invoke(action, payload); if (result?.error) setError(String(result.error)); await refresh(); return result; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
    finally { setBusy(false); }
  };
  const startBackgroundProcess = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const parsed = JSON.parse(processArgs) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new Error("Arguments must be a JSON array of strings.");
      const result = await call("process:start", { command: processCommand, args: parsed, cwd: processCwd, interactive: processInteractive });
      if (result && !result.error) setProcessCommand("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const runAgent = async (event: React.FormEvent) => {
    event.preventDefault(); if (!objective.trim()) return;
    if (agentRunning) {
      const runId = activeAgentRunId.current;
      if (!runId) return;
      try { const result = await window.xyst.sendAgentMessage(runId, objective.trim()); if (!result.accepted) throw new Error("The active task could not accept that message."); setObjective(""); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      return;
    }
    if (runtimeState !== "ready") { setError("The runtime is not ready yet. Refresh the dashboard and inspect any reported error."); return; }
    const runId = crypto.randomUUID(); activeAgentRunId.current = runId;
    setEvents([]); setBusy(true); setAgentRunning(true); setCancelRequested(false); setError("");
    try { await window.xyst.runAgent(objective.trim(), attachments, runId); setObjective(""); setAttachments([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { activeAgentRunId.current = null; setBusy(false); setAgentRunning(false); setCancelRequested(false); await refresh(); }
  };
  const stopAgent = async () => {
    const runId = activeAgentRunId.current;
    if (!runId || cancelRequested) return;
    setCancelRequested(true);
    try {
      const result = await window.xyst.cancelAgent(runId);
      if (!result.cancelled) setError("The task has already stopped or its cancellation channel is unavailable.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setCancelRequested(false); }
  };
  const chooseAttachments = async () => {
    try { const selected = await window.xyst.pickAttachments(); if (selected.length) setAttachments(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const createMission = async () => {
    try {
      const definition = JSON.parse(missionJson);
      setBusy(true); await window.xyst.createMission(definition); setShowMissionEditor(false); setMissionJson(""); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const loadMissionTemplate = async () => {
    const definition = await call("mission:template", { id: missionTemplateId });
    if (definition) setMissionJson(JSON.stringify(definition, null, 2));
  };
  const setResourceBudget = (value: string) => void call("setting:resource-budget", { bytes: value === "auto" ? null : Number(value) });
  const setConcurrencyLimit = (value: string) => void call("setting:concurrency", { value: Number(value) });
  const setParallelReadLimit = (value: number) => void call("setting:parallel-reads", { value });
  const planMission = async () => {
    if (!missionObjective.trim()) return;
    const result = await call("mission:plan", { objective: missionObjective.trim() });
    if (result?.definition) setMissionJson(JSON.stringify(result.definition, null, 2));
  };
  const openMissionEditor = async () => {
    try {
      const templates = await window.xyst.invoke("mission:templates");
      setMissionTemplates(Array.isArray(templates) ? templates : []);
      setShowMissionEditor(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const searchHuggingFace = async (event: React.FormEvent) => {
    event.preventDefault(); const found = await call("hf:search", { query: hfQuery.trim() });
    if (!Array.isArray(found)) return;
    try {
      const modelsWithFiles = await Promise.all(found.slice(0, 8).map(async (model) => await window.xyst.invoke("hf:inspect", { repository: model.id })));
      setHfResults(modelsWithFiles.filter((model) => model && typeof model === "object"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const recommendHuggingFace = async () => {
    const result = await call("hf:recommend", { query: hfQuery.trim() });
    if (Array.isArray(result)) setHfRecommendations(result);
  };
  const updateModelLoadForm = (key: string, field: keyof LMLoadForm, value: string) => setModelLoadForms((current) => ({ ...current, [key]: { ...emptyLoadForm, ...current[key], [field]: value } }));
  const loadModel = async (key: string) => {
    const form = { ...emptyLoadForm, ...modelLoadForms[key] };
    const options: Record<string, number | boolean | string> = {};
    if (form.contextLength) options.context_length = Number(form.contextLength);
    if (form.ttlSeconds) options.ttl_seconds = Number(form.ttlSeconds);
    if (form.evalBatchSize) options.eval_batch_size = Number(form.evalBatchSize);
    if (form.numExperts) options.num_experts = Number(form.numExperts);
    if (form.flashAttention !== "default") options.flash_attention = form.flashAttention === "on";
    if (form.kvCacheGpu !== "default") options.offload_kv_cache_to_gpu = form.kvCacheGpu === "on";
    if (form.gpuOffload !== "default") options.gpu_offload = ["auto", "off", "max"].includes(form.gpuOffload) ? form.gpuOffload : Number(form.gpuOffload);
    if (form.draftMode === "mtp") options.speculative_draft_mtp = true;
    if (form.draftMode === "simple" && form.draftModel) options.draft_model = form.draftModel;
    if (form.draftMaxTokens) options.speculative_draft_max_tokens = Number(form.draftMaxTokens);
    if (form.draftMinTokens) options.speculative_draft_min_tokens = Number(form.draftMinTokens);
    if (form.draftMinProbability) options.speculative_draft_min_continue_probability = Number(form.draftMinProbability);
    const result = await call("lm:load", { model: key, options });
    if (result && typeof result === "object" && (result as Record<string, unknown>).source === "lms CLI") {
      const gpu = (result as Record<string, unknown>).gpu_offload;
      const draft = (result as Record<string, unknown>).draft_model;
      setModelLoadNotes((current) => ({ ...current, [key]: "Last local CLI load completed" + ((result as Record<string, unknown>).ttl_seconds !== undefined ? " · idle TTL " + String((result as Record<string, unknown>).ttl_seconds) + "s" : "") + (gpu !== undefined ? " · GPU target " + String(gpu) + " (actual layer allocation unavailable)" : "") + (draft ? " · draft model " + String(draft) : (result as Record<string, unknown>).speculative_draft_mtp ? " · Draft MTP requested" : "") + "." }));
    }
    return result;
  };
  const estimateModelLoad = async (key: string) => {
    const form = { ...emptyLoadForm, ...modelLoadForms[key] };
    const options: Record<string, number | string> = {};
    if (form.contextLength) options.context_length = Number(form.contextLength);
    if (form.gpuOffload !== "default") options.gpu_offload = ["auto", "off", "max"].includes(form.gpuOffload) ? form.gpuOffload : Number(form.gpuOffload);
    const result = await call("lm:estimate", { model: key, options });
    if (result && typeof result === "object") setModelLoadNotes((current) => ({ ...current, [key]: "Estimate only · " + String((result as Record<string, unknown>).output ?? "No estimate detail returned") }));
  };
  const openSession = async (session: Record<string, any>) => {
    setSelectedSession(session); setView("sessions");
    const [messages, calls, artifacts] = await Promise.all([call("session:show", { id: session.id }), call("session:calls", { id: session.id }), call("session:artifacts", { id: session.id })]);
    if (Array.isArray(messages)) setSessionMessages(messages);
    if (Array.isArray(calls)) setSessionCalls(calls);
    if (Array.isArray(artifacts)) setSessionArtifacts(artifacts);
  };
  const manageSession = async (action: "rename" | "fork" | "archive" | "delete" | "export" | "compact") => {
    if (!selectedSession) return;
    if (action === "rename") {
      const title = window.prompt("Session name", selectedSession.title);
      if (title === null || !title.trim()) return;
      if (!await call("session:rename", { id: selectedSession.id, title })) return;
    } else if (action === "fork") {
      const result = await call("session:fork", { id: selectedSession.id });
      if (result && typeof result === "object" && typeof (result as any).id === "string") {
        const listed = await window.xyst.invoke("session:list"); const session = Array.isArray(listed) ? (listed as Array<Record<string, any>>).find((item) => item.id === (result as any).id) : undefined;
        if (session) await openSession(session);
      }
      return;
    } else if (action === "archive") {
      if (!window.confirm(`Archive “${selectedSession.title}”?`)) return;
      if (!await call("session:archive", { id: selectedSession.id })) return;
    } else if (action === "delete") {
      if (!window.confirm(`Permanently delete “${selectedSession.title}” and its saved conversation data?`)) return;
      if (!await call("session:delete", { id: selectedSession.id })) return;
    } else if (action === "compact") {
      const result = await call("session:compact", { id: selectedSession.id });
      if (!result || (result as Record<string, unknown>).error) return;
      await openSession(selectedSession);
      return;
    } else if (!await call("session:export", { id: selectedSession.id })) return;
    if (action === "archive" || action === "delete") { setSelectedSession(null); setSessionMessages([]); setSessionCalls([]); setSessionArtifacts([]); }
    await refresh();
  };
  const resumeSession = async (event: React.FormEvent) => {
    event.preventDefault(); if (!selectedSession || !sessionReply.trim()) return;
    if (agentRunning) {
      const runId = activeAgentRunId.current;
      if (!runId) return;
      try { const result = await window.xyst.sendAgentMessage(runId, sessionReply.trim()); if (!result.accepted) throw new Error("The active task could not accept that message."); setSessionReply(""); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      return;
    }
    const runId = crypto.randomUUID(); activeAgentRunId.current = runId;
    setEvents([]); setBusy(true); setAgentRunning(true); setCancelRequested(false); setError("");
    try { await window.xyst.resumeSession(selectedSession.id, sessionReply.trim(), attachments, runId); setSessionReply(""); setAttachments([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      activeAgentRunId.current = null; setBusy(false); setAgentRunning(false); setCancelRequested(false);
      const [messages, calls, artifacts] = await Promise.all([window.xyst.invoke("session:show", { id: selectedSession.id }), window.xyst.invoke("session:calls", { id: selectedSession.id }), window.xyst.invoke("session:artifacts", { id: selectedSession.id })]);
      if (Array.isArray(messages)) setSessionMessages(messages);
      if (Array.isArray(calls)) setSessionCalls(calls);
      if (Array.isArray(artifacts)) setSessionArtifacts(artifacts);
      await refresh();
    }
  };
  const setModelSetting = async (name: "auto" | "loading" | "unloading" | "remote-fallback" | "discovery" | "downloads" | "switching", enabled: boolean) => { await call(`setting:model-${name}`, { enabled }); };
  const setInferenceSettings = async (values: Record<string, string>) => {
    let stops: unknown = values.stopSequences.trim() || null;
    if (typeof stops === "string" && stops.startsWith("[")) { try { stops = JSON.parse(stops); } catch { setError("Stop sequences that start with [ must be a valid JSON array."); return; } }
    const definitions: Array<[string, unknown]> = [["inference.temperature", values.temperature.trim() ? Number(values.temperature) : null], ["inference.maxTokens", values.maxTokens.trim() ? Number(values.maxTokens) : null], ["inference.requestTimeoutSeconds", Number(values.requestTimeoutSeconds)], ["inference.topP", values.topP.trim() ? Number(values.topP) : null], ["inference.topK", values.topK.trim() ? Number(values.topK) : null], ["inference.repeatPenalty", values.repeatPenalty.trim() ? Number(values.repeatPenalty) : null], ["inference.presencePenalty", values.presencePenalty.trim() ? Number(values.presencePenalty) : null], ["inference.frequencyPenalty", values.frequencyPenalty.trim() ? Number(values.frequencyPenalty) : null], ["inference.stopSequences", stops], ["inference.reasoning", values.reasoning.trim() || null]];
    for (const [key, value] of definitions) if (!await call("setting:inference", { key, value })) return;
  };
  const setPreference = (name: keyof typeof prefs) => {
    if (typeof prefs[name] === "boolean") {
      const next = !prefs[name];
      if (name === "soundAlerts") {
        if (next) activateSoundAlerts();
        else if (audioContext.current?.state === "running") void audioContext.current.suspend().catch(() => undefined);
      }
    }
    setPrefs((current) => {
    if (typeof current[name] !== "boolean") return current;
    const updated = { ...current, [name]: !current[name] } as typeof current; localStorage.setItem(`xyst.${name}`, String(updated[name])); document.documentElement.dataset[name] = String(updated[name]); return updated;
    });
  };
  const setLayoutPanel = (name: LayoutPanel, visible: boolean) => {
    setLayout((current) => {
      const updated = { ...current, [name]: visible };
      try { localStorage.setItem("xyst.layout", JSON.stringify(updated)); } catch { setError("Could not save workspace panel preferences in local storage."); }
      return updated;
    });
  };
  const setAccent = (accent: string) => { if (!["green", "cyan", "violet"].includes(accent)) return; setPrefs((current) => ({ ...current, accent })); localStorage.setItem("xyst.accent", accent); document.documentElement.dataset.accent = accent; };
  const status = snapshot.status;
  const runtimeReady = runtimeState === "ready";
  const modelsAvailable = runtimeReady && !snapshot.modelsError;
  const runtimeLabel = runtimeState === "checking" ? "CHECKING RUNTIME" : runtimeReady ? "RUNTIME READY" : "RUNTIME UNAVAILABLE";
  const profileValue = status.profile ?? snapshot.settings?.accessProfile?.value;
  const profileMode = typeof profileValue === "string" ? profileValue : String(profileValue?.mode ?? "unknown");
  const profileLabel = runtimeState === "checking" ? "checking" : runtimeReady ? profileMode : "unavailable";
  const currentModel = models.find((model) => model.loaded_instances?.length)?.name ?? "No model loaded";

  return <div className="app-shell">
    {layout.navigation && <aside className="sidebar">
      <div className="brand"><RobotMark/><div><strong>XYST</strong><span>CONTROL ROOM</span></div><span className="brand-version">0.1</span></div>
      <div className="workspace-chip"><span className="workspace-marker" aria-hidden="true"/>LOCAL WORKSPACE<i>⌄</i></div>
      <div className="nav-label">COMMAND</div>
      <nav>
        <button className={view === "overview" ? "nav-item active" : "nav-item"} onClick={() => setView("overview")}><b>⌂</b>Overview<span className="nav-count">01</span></button>
        <button className={view === "sessions" ? "nav-item active" : "nav-item"} onClick={() => setView("sessions")}><b>◷</b>Sessions<span className="nav-count">{snapshot.sessions.length.toString().padStart(2, "0")}</span></button>
        <button className={view === "missions" ? "nav-item active" : "nav-item"} onClick={() => setView("missions")}><b>⎇</b>Missions<span className="nav-count">{missions.length.toString().padStart(2, "0")}</span></button>
        <button className={view === "agents" ? "nav-item active" : "nav-item"} onClick={() => setView("agents")}><b>◉</b>Agents<span className="nav-count">{agents.length.toString().padStart(2, "0")}</span></button>
        <button className={view === "jobs" ? "nav-item active" : "nav-item"} onClick={() => setView("jobs")}><b>▤</b>Jobs<span className="nav-count">{jobs.length.toString().padStart(2, "0")}</span></button>
        <button className={view === "terminal" ? "nav-item active" : "nav-item"} onClick={() => setView("terminal")}><b>⌗</b>Terminal</button>
        <button className={view === "models" ? "nav-item active" : "nav-item"} onClick={() => setView("models")}><b>◈</b>Model dock<span className="nav-count">{loadedCount.toString().padStart(2, "0")}</span></button>
        <button className={view === "github" ? "nav-item active" : "nav-item"} onClick={() => setView("github")}><b>⌘</b>GitHub bridge</button>
        <button className={view === "changes" ? "nav-item active" : "nav-item"} onClick={() => setView("changes")}><b>⌁</b>Changes</button>
      </nav>
      <div className="nav-label secondary-label">SYSTEM</div>
      <button className={view === "memory" ? "nav-item active" : "nav-item"} onClick={() => setView("memory")}><b>✧</b>Memory<span className="nav-count">{snapshot.memories.length.toString().padStart(2, "0")}</span></button>
      <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => setView("settings")}><b>⚙</b>Settings</button>
      <div className="sidebar-spacer"/>
      <div className={`robot-card ${runtimeState}`}><div className="robot-eye"><RobotMark/></div><div><small>UNIT STATUS</small><strong>{runtimeState === "checking" ? "INITIALIZING" : runtimeReady ? "ALLY ONLINE" : "RUNTIME OFFLINE"}</strong><span>{runtimeReady ? "Ready for your next directive" : runtimeState === "checking" ? "Checking local services" : "Refresh or inspect the error"}</span></div><span className="pulse"/></div>
      <div className="profile-line"><span>ACCESS PROFILE</span><strong>{profileLabel}</strong></div>
    </aside>}

    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>LOCAL SYSTEM</span><i>/</i><strong>{viewOptions.find(([key]) => key === view)?.[1].toUpperCase() ?? "OVERVIEW"}</strong></div><div className="topbar-right">{!layout.navigation && <select className="layout-page-select" aria-label="Navigate to page" value={view} onChange={(event) => setView(event.target.value as View)}>{viewOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}<div className="layout-control"><button className="secondary-button layout-button" aria-expanded={layoutMenuOpen} aria-controls="layout-panel-menu" onClick={() => setLayoutMenuOpen((open) => !open)}>Panels</button>{layoutMenuOpen && <section id="layout-panel-menu" className="layout-menu" aria-label="Visible workspace panels"><div className="layout-menu-title"><strong>WORKSPACE PANELS</strong><button className="icon-button" aria-label="Close panel menu" onClick={() => setLayoutMenuOpen(false)}>×</button></div><p>Show or hide the main control-room panels. Your choices are saved on this device.</p>{layoutPanelOptions.map((option) => <label className="layout-option" key={option.key}><span><strong>{option.title}</strong><small>{option.description}</small></span><input type="checkbox" checked={layout[option.key]} onChange={(event) => setLayoutPanel(option.key, event.target.checked)} aria-label={option.title}/></label>)}</section>}</div><span className={`server-state ${runtimeState}`} role="status" aria-live="polite"><i/>{runtimeLabel}</span><span className="separator"/><span className="clock">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><button className="avatar" aria-label="Profile">X</button></div></header>
      {error && <div className="error-banner" role="alert"><div className="error-message"><span>⚠ {error}</span>{errorDetails && <details className="error-details"><summary>Technical details</summary><pre>{errorDetails}</pre></details>}</div><button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
      {layout.centerPanel && <div className="center-workspace">
      {view === "overview" && <section className="content overview-content">
        <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-line"/>{runtimeState === "checking" ? "CHECKING LOCAL RUNTIME" : runtimeReady ? "LOCAL AI SYSTEMS ONLINE" : "LOCAL RUNTIME UNAVAILABLE"}</div><h1>Good to see you, <em>Operator.</em></h1><p>Your control room is ready. Here’s what’s happening across your local agents.</p></div><button className="refresh-button" onClick={() => void refresh()} title="Refresh"><span>↻</span> Refresh</button></div>
        {layout.overviewStats && <div className="stat-grid">
          <article className="stat-card"><div className="stat-top"><span>ACTIVE MISSIONS</span><b className="stat-icon mint">⎇</b></div><strong className="stat-number">{missions.filter((mission) => ["active", "running"].includes(mission.status)).length.toString().padStart(2, "0")}</strong><div className="stat-foot"><span className="mint-text">{missions.length} saved</span><span> across your workspace</span></div></article>
          <article className="stat-card"><div className="stat-top"><span>LOCAL MODELS</span><b className="stat-icon blue">◈</b></div><strong className="stat-number">{modelsAvailable ? models.length.toString().padStart(2, "0") : "—"}</strong><div className="stat-foot"><span className="blue-text">{!modelsAvailable ? "Unavailable" : `${loadedCount} loaded`}</span><span>{!modelsAvailable ? " · check Model dock" : loadedCount ? " · ready for tasks" : " · no model loaded"}</span></div></article>
          <article className="stat-card"><div className="stat-top"><span>SAVED SESSIONS</span><b className="stat-icon violet">◷</b></div><strong className="stat-number">{snapshot.sessions.length.toString().padStart(2, "0")}</strong><div className="stat-foot"><span className="violet-text">Persistent</span><span> across CLI and desktop</span></div></article>
          <article className="stat-card"><div className="stat-top"><span>RUNTIME</span><b className="stat-icon amber">⌁</b></div><strong className={`stat-word ${runtimeState}`}><i/>{runtimeState === "checking" ? "CHECKING" : runtimeReady ? "READY" : "ERROR"}</strong><div className="stat-foot"><span>{status.dataDir ?? "Local state"}</span></div></article>
        </div>}
        <div className="dashboard-grid">
          {layout.taskPanel && <section className="panel directive-panel"><div className="panel-head"><div><div className="eyebrow small-eyebrow">DIRECT LINE</div><h2>Give Xyst a task</h2></div><span className={`tag-live ${runtimeState}`}><i/>{runtimeState === "checking" ? "CHECKING RUNTIME" : runtimeReady ? "AGENT READY" : "RUNTIME UNAVAILABLE"}</span></div><p className="panel-copy">The local agent can inspect and change files in your workspace, run tools, and verify its work.</p>
            <form onSubmit={runAgent} className="directive-form"><textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder={agentRunning ? "Add guidance to the running task..." : "Describe what you want Xyst to do..."} rows={3} aria-label="Task for Xyst"/><div className="attachment-tools"><button type="button" className="secondary-button" disabled={busy} onClick={() => void chooseAttachments()}>Attach files <b>＋</b></button>{attachments.length > 0 && <><span title={attachments.join("\n")}>{attachments.map((path) => path.split(/[\\/]/).pop()).join(" · ")}</span><button type="button" className="text-button" onClick={() => setAttachments([])}>Clear</button></>}</div><div className="form-bottom"><span><b>↳</b> Workspace files and installed tools</span>{agentRunning ? <><button className="primary-button" disabled={!objective.trim()}>{<>Send message <b>↗</b></>}</button><button type="button" className="secondary-button" disabled={cancelRequested} onClick={() => void stopAgent()}>{cancelRequested ? "Stopping…" : "Stop task"}</button></> : <button className="primary-button" disabled={runtimeState !== "ready" || busy || !objective.trim()}>{busy ? <><i className="spinner"/> Working</> : <>Run task <b>↗</b></>}</button>}</div></form>
            {events.length > 0 && <div className="activity-feed" aria-live="polite">{events.slice(-5).map((event, index) => <EventLine key={`${event.at ?? ""}-${index}`} event={event}/>)}</div>}
          </section>}
          {layout.modelPanel && <section className="panel model-panel"><div className="panel-head"><div><div className="eyebrow small-eyebrow">INFERENCE ENGINE</div><h2>Model status</h2></div><button className="icon-button" aria-label="Open model management" title="Open model management" onClick={() => setView("models")}>↗</button></div><div className="model-orb"><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/><div className="orb-core"><span>◈</span></div><i className="orb-dot dot-a"/><i className="orb-dot dot-b"/><i className="orb-dot dot-c"/></div><div className="model-status-name">{currentModel}</div><div className={`model-subline ${snapshot.modelsError || runtimeState === "unavailable" ? "offline" : ""}`} role="status" aria-live="polite" title={snapshot.modelsError}><i/>{runtimeState === "unavailable" ? "Runtime unavailable · inspect error" : runtimeState === "checking" ? "Checking LM Studio…" : snapshot.modelsError ? "LM Studio unavailable · check Model dock" : loadedCount ? "Connected to LM Studio" : "LM Studio connected · no model loaded"}</div><button className="secondary-button full-button" onClick={() => setView("models")}>Manage local models <span>→</span></button></section>}
        </div>
        {layout.missionPanel && <section className="panel mission-summary"><div className="panel-head"><div><div className="eyebrow small-eyebrow">AUTOMATION</div><h2>Recent missions</h2></div><button className="text-button" onClick={() => setView("missions")}>View all <span>→</span></button></div>
          {missions.length ? <div className="mission-table">{missions.slice(0, 4).map((mission) => <MissionRow key={mission.id} mission={mission} onAction={call}/>)}</div> : <div className="empty-state"><span className="empty-glyph">⎇</span><strong>No missions created yet</strong><p>Save repeatable workflows as missions and track them here.</p><button className="secondary-button" onClick={() => { setView("missions"); void openMissionEditor(); }}>Create your first mission <span>＋</span></button></div>}
        </section>}
      </section>}

      {view === "jobs" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>DURABLE WORK QUEUE</div><h1>Job <em>records.</em></h1><p>Inspect mission, download, and process jobs. Process arguments are passed directly without a shell.</p></div><button className="refresh-button" onClick={() => void call("jobs:list")}>↻ Refresh</button></div><form className="process-job-form" onSubmit={(event) => void startBackgroundProcess(event)}><label>Executable<input aria-label="Background process executable" value={processCommand} onChange={(event) => setProcessCommand(event.target.value)} placeholder="node" required/></label><label>Arguments as JSON array<input aria-label="Background process arguments" value={processArgs} onChange={(event) => setProcessArgs(event.target.value)} placeholder='["-e", "console.log(1)"]'/></label><label>Working directory<input aria-label="Background process working directory" value={processCwd} onChange={(event) => setProcessCwd(event.target.value)} placeholder="Current directory"/></label><label className="process-interactive"><input type="checkbox" checked={processInteractive} onChange={(event) => setProcessInteractive(event.target.checked)}/>Keep stdin open for interaction</label><button className="secondary-button" disabled={busy}>Start background job</button></form><div className="filter-row"><span>{jobs.length} recent jobs</span><span className="tag-live"><i/>PERSISTED STATE</span></div>{jobs.length ? <div className="mission-list">{jobs.map((job) => <details className="tool-log-item" key={`${job.kind}:${job.id}`}><summary><span className="tool-log-name">{job.kind}</span><span className={`status-pill ${["failed", "uncertain"].includes(String(job.state)) ? "status-bad" : ["completed", "succeeded"].includes(String(job.state)) ? "status-good" : ""}`}>{job.state}</span><small>{job.updated_at ? new Date(job.updated_at).toLocaleString() : ""}</small></summary><div className="tool-log-content"><section><b>JOB ID</b><pre>{job.id}</pre></section><section><b>CREATED</b><pre>{job.created_at ?? "unknown"}</pre></section><section><b>DETAILS</b><pre>{prettyStoredJson(job.details)}</pre></section>{job.kind === "process" && job.details?.interactive === true && !["completed", "failed", "cancelled"].includes(String(job.state)) && <form className="process-input-form" onSubmit={(event) => { event.preventDefault(); const input = processInputDrafts[job.id] ?? ""; if (input) void call("process:input", { id: job.id, input: input + "\n" }).then((result) => { if (result) setProcessInputDrafts((current) => ({ ...current, [job.id]: "" })); }); }}><input aria-label={`stdin input for ${job.id}`} value={processInputDrafts[job.id] ?? ""} onChange={(event) => setProcessInputDrafts((current) => ({ ...current, [job.id]: event.target.value }))} placeholder="Send stdin text"/><button className="secondary-button" disabled={busy || !(processInputDrafts[job.id] ?? "").length}>Send stdin</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void call("process:end-input", { id: job.id })}>Close stdin</button></form>}{job.kind === "process" && !["completed", "failed", "cancelled"].includes(String(job.state)) && <button className="secondary-button" onClick={() => void call("process:stop", { id: job.id })}>Stop process tree</button>}</div></details>)}</div> : <div className="panel empty-page"><div className="empty-glyph">▤</div><h2>No durable jobs yet</h2><p>Start a background process here, or mission and download jobs will appear when queued.</p></div>}</section>}

      {view === "terminal" && <Suspense fallback={<section className="content page-content"><p className="settings-foot">Loading terminal…</p></section>}><TerminalView jobs={jobs} onRefresh={refresh}/></Suspense>}

      {view === "sessions" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>PERSISTENT WORK</div><h1>Saved <em>sessions.</em></h1><p>Continue an agent conversation saved by the CLI or desktop.</p></div><button className="refresh-button" onClick={() => void refresh()}>↻ Refresh</button></div><div className="session-layout"><section className="panel session-list"><div className="panel-head"><div><div className="eyebrow small-eyebrow">SESSION ARCHIVE</div><h2>{snapshot.sessions.length} saved</h2></div></div>{snapshot.sessions.length ? snapshot.sessions.map((session: any) => <button className={`session-item ${selectedSession?.id === session.id ? "selected" : ""}`} key={session.id} onClick={() => void openSession(session)}><span className="session-icon">◷</span><span><strong>{session.title}</strong><small>{new Date(session.updated_at).toLocaleString()}</small></span></button>) : <div className="download-empty">No saved sessions yet. Run a task from Overview to start one.</div>}</section><section className="panel conversation-panel">{selectedSession ? <><div className="panel-head conversation-head"><div><div className="eyebrow small-eyebrow">SESSION</div><h2>{selectedSession.title}</h2></div><div className="session-header-actions"><span className={`status-pill ${selectedSession.status === "completed" ? "status-good" : ["failed", "unverified", "cancelled"].includes(String(selectedSession.status)) ? "status-bad" : ""}`}>{selectedSession.status}</span><button className="text-button" onClick={() => void manageSession("compact")} disabled={busy || agentRunning} title="Summarize completed history for future resumes; the full transcript remains available">Compact</button><button className="text-button" onClick={() => void manageSession("rename")}>Rename</button><button className="text-button" onClick={() => void manageSession("fork")}>Fork</button><button className="text-button" onClick={() => void manageSession("export")}>Export</button><button className="text-button" onClick={() => void manageSession("archive")}>Archive</button><button className="text-button" onClick={() => void manageSession("delete")}>Delete</button></div></div><div className="conversation-history">{sessionMessages.map((message, index) => <article className={`conversation-message ${message.role === "user" ? "user-message" : ""}`} key={`${message.id ?? "message"}-${index}`}><span>{message.role}</span><pre>{renderMessageContent(message.content)}</pre></article>)}{events.slice(-8).map((event, index) => <EventLine key={`event-${index}`} event={event}/>)}</div><section className="session-tool-log"><div className="panel-title"><div><div className="eyebrow small-eyebrow">EXECUTION RECORD</div><h3>Tool log · {sessionCalls.length}</h3></div></div>{sessionCalls.length ? sessionCalls.map((entry) => <details className="tool-log-item" key={entry.id}><summary><span className="tool-log-name">{entry.name}</span><span className={`status-pill ${entry.status === "completed" ? "status-good" : entry.status === "failed" || entry.status === "uncertain" ? "status-bad" : ""}`}>{entry.status}{entry.effect ? ` · ${entry.effect}` : ""}</span><small>{entry.created_at ? new Date(entry.created_at).toLocaleString() : ""}</small></summary><div className="tool-log-content"><section><b>INPUT</b><pre>{prettyStoredJson(entry.input_json)}</pre></section><section><b>OUTPUT</b><pre>{prettyStoredJson(entry.output_json ?? "Not available")}</pre></section></div></details>) : <p className="download-empty">No tool calls were saved for this session.</p>}</section>
<section className="session-artifacts"><div className="panel-title"><div><div className="eyebrow small-eyebrow">SAVED OUTPUT</div><h3>Artifacts · {sessionArtifacts.length}</h3></div></div>{sessionArtifacts.length ? sessionArtifacts.map((entry) => <details className="tool-log-item" key={entry.id}><summary><span className="tool-log-name">{entry.name}</span><span className="model-badge">{entry.mime_type ?? "file"}</span><small>{entry.created_at ? new Date(entry.created_at).toLocaleString() : ""}</small></summary><div className="tool-log-content"><section><b>PATH</b><pre>{entry.path}</pre></section><section><b>IDENTITY</b><pre>{prettyStoredJson(entry.metadata_json)}</pre></section><button type="button" className="row-action" onClick={() => { void window.xyst.openSessionArtifact(selectedSession.id, entry.id).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }}>Open file ↗</button></div></details>) : <p className="download-empty">No generated or edited files were registered for this session.</p>}</section>
<form className="session-reply" onSubmit={resumeSession}><textarea value={sessionReply} onChange={(event) => setSessionReply(event.target.value)} placeholder={agentRunning ? "Add guidance to the running task..." : "Continue this conversation..."} aria-label="Continue saved session" rows={2}/><div className="session-reply-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void chooseAttachments()}>Attach files</button>{agentRunning ? <><button className="primary-button" disabled={!sessionReply.trim()}>Send message <b>↗</b></button><button type="button" className="secondary-button" disabled={cancelRequested} onClick={() => void stopAgent()}>{cancelRequested ? "Stopping…" : "Stop task"}</button></> : <button className="primary-button" disabled={busy || !sessionReply.trim()}>{busy ? "Working…" : <>Continue <b>↗</b></>}</button>}</div>{attachments.length > 0 && <div className="attachment-tools session-attachment-tools"><span title={attachments.join("\n")}>{attachments.map((path) => path.split(/[\\/]/).pop()).join(" · ")}</span><button type="button" className="text-button" onClick={() => setAttachments([])}>Clear</button></div>}</form></> : <div className="empty-page"><div className="empty-glyph">◷</div><h2>Select a session to continue</h2><p>Session history is shared across the desktop and CLI.</p></div>}</section></div></section>}

      {view === "missions" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>AUTOMATION CONTROL</div><h1>Mission <em>control.</em></h1><p>Durable workflows, task checkpoints, and schedules shared with your CLI.</p></div><button className="primary-button" onClick={() => void openMissionEditor()}>New mission <b>＋</b></button></div>
        <div className="filter-row"><span>{missions.length} missions</span><span className="tag-live"><i/>LIVE STATE</span></div>
        {missions.length ? <div className="mission-list">{missions.map((mission) => <MissionCard key={mission.id} mission={mission} onAction={call}/>)}</div> : <div className="panel empty-page"><div className="empty-glyph">⎇</div><h2>Your mission board is clear</h2><p>Create a mission with a task graph or a recurring schedule.</p><button className="primary-button" onClick={() => void openMissionEditor()}>Create mission <b>＋</b></button></div>}
      </section>}

      {view === "agents" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>DELEGATED WORK</div><h1>Agent <em>fleet.</em></h1><p>Task assignments and durable execution state shared with the CLI.</p></div><button className="refresh-button" onClick={() => void refresh()}>↻ Refresh</button></div><div className="filter-row"><span>{agents.length} agent runs</span><span className="tag-live"><i/>PERSISTED STATE</span></div>{agents.length ? <div className="mission-list">{agents.map((agent) => { const definition = agent.definition ?? {}; const role = definition.profile ?? {}; return <article className="panel mission-card" key={agent.id}><div className="mission-card-head"><span className="mission-symbol">◉</span><span className={`status-pill ${statusClass(agent.status)}`}>{agent.status}</span></div><h2>{role.name ?? definition.name ?? "Mission agent"}</h2><p>Task {definition.taskId ?? "—"} · {definition.id ?? "default"}</p><div className="mission-card-meta"><span>Model {definition.model ?? role.model ?? "automatic"}</span><span>Turns {role.maxTurns ?? "default"}</span><span>{definition.workspace ?? "workspace not recorded"}</span></div>{definition.expectedOutputs?.length ? <p>Expected: {definition.expectedOutputs.join(" · ")}</p> : null}{definition.completionCriteria && <p>Criteria: {definition.completionCriteria}</p>}{definition.modelSelectionReason && <p className="agent-control-note">{definition.modelSelectionReason}{definition.estimatedAdditionalMemoryBytes ? ` · estimated ${formatBytes(definition.estimatedAdditionalMemoryBytes)} additional memory` : ""}</p>}<AgentControls agent={agent} missions={missions} onAction={call} busy={busy}/></article>; })}</div> : <div className="panel empty-page"><div className="empty-glyph">◉</div><h2>No agent runs yet</h2><p>Mission tasks create persisted agent records when they start.</p></div>}</section>}

      {view === "models" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>LOCAL INFERENCE</div><h1>Model <em>dock.</em></h1><p>Manage models already available to your LM Studio server.</p></div><button className="refresh-button" onClick={() => void refresh()}>↻ Refresh inventory</button></div><div className="notice-line">Xyst uses your local LM Studio installation. Downloads and online model search are controlled in Settings.</div>{snapshot.systemResources?.systemMemory && <section className="panel resource-card"><div className="panel-head"><div><div className="eyebrow small-eyebrow">LIVE MEASUREMENTS</div><h2>Host resources</h2></div><span>{snapshot.systemResources.checkedAt ? new Date(snapshot.systemResources.checkedAt).toLocaleTimeString() : "Current"}</span></div><div className="mission-card-meta"><span>RAM {formatBytes(snapshot.systemResources.systemMemory.usedBytes)} used / {formatBytes(snapshot.systemResources.systemMemory.totalBytes)}</span><span>{formatBytes(snapshot.systemResources.systemMemory.availableBytes)} available · {snapshot.systemResources.systemMemory.usedPercent}% used</span></div>{snapshot.systemResources.nvidiaGpuMemory?.devices?.length ? snapshot.systemResources.nvidiaGpuMemory.devices.map((gpu: Record<string, any>) => <p key={gpu.name}>{gpu.name} · VRAM {formatBytes(gpu.usedBytes)} / {formatBytes(gpu.totalBytes)} used · {formatBytes(gpu.freeBytes)} free</p>) : <p className="settings-foot">NVIDIA VRAM: {snapshot.systemResources.nvidiaGpuMemory?.status ?? "unavailable"}{snapshot.systemResources.nvidiaGpuMemory?.reason ? ` · ${snapshot.systemResources.nvidiaGpuMemory.reason}` : ""}. This is the machine running Xyst; remote LM Studio resources and non-NVIDIA GPUs are not measured.</p>}</section>}{snapshot.modelsError && <div className="error-banner model-error"><span>LM Studio model inventory unavailable: {snapshot.modelsError}</span><button aria-label="Retry model inventory" title="Retry model inventory" onClick={() => void refresh()}>↻</button></div>}
        <div className="model-tabs"><button className={modelTab === "local" ? "selected" : ""} onClick={() => setModelTab("local")}>Local library <span>{models.length}</span></button><button className={modelTab === "huggingface" ? "selected" : ""} onClick={() => setModelTab("huggingface")}>Hugging Face <span>SEARCH + DOWNLOADS</span></button></div>
        {modelTab === "local" ? <><div className="model-grid">{models.map((model) => { const form = { ...emptyLoadForm, ...modelLoadForms[model.key] }; const loadedConfig = model.loaded_instances?.[0]?.config ?? {}; const supportsLlamaLoadOptions = model.type === "llm" || model.type === "decision"; const cliLoadRequested = form.gpuOffload !== "default" || Boolean(form.ttlSeconds) || form.draftMode !== "default" || Boolean(form.draftMaxTokens || form.draftMinTokens || form.draftMinProbability); const cliLoadConflict = cliLoadRequested && (Boolean(form.evalBatchSize || form.numExperts) || form.flashAttention !== "default" || form.kvCacheGpu !== "default"); const draftIncomplete = form.draftMode === "simple" && !form.draftModel; return <article className="model-card" key={model.key}><div className="model-card-top"><span className="model-badge">{model.type === "llm" ? "LLM" : String(model.type).toUpperCase()}</span><span className={model.loaded_instances?.length ? "state-pill active-pill" : "state-pill"}><i/>{model.loaded_instances?.length ? "LOADED" : "AVAILABLE"}</span></div><h3>{model.name ?? model.key}</h3><p className="model-key">{model.key}</p><div className="model-meta"><span>{model.quantization ?? "Quantization unknown"}</span><span>{formatBytes(model.sizeBytes)}</span><span>{model.maxContext ? `${Number(model.maxContext).toLocaleString()} context` : "Context unknown"}</span>{model.performance?.samples ? <span>{model.performance.samples} inference calls · {Number(model.performance.medianLatencyMs).toLocaleString()} ms median{model.performance.tokensPerSecond ? ` · ${model.performance.tokensPerSecond} tokens/s` : ""}{model.performance.taskSamples ? ` · ${model.performance.taskSuccesses}/${model.performance.taskSamples} verified tasks completed` : ""}</span> : null}</div><div className="model-capabilities">{model.capabilities?.trained_for_tool_use && <span>TOOL USE</span>}{model.capabilities?.vision && <span>VISION</span>}{model.type === "embedding" && <span>EMBEDDING</span>}</div>{model.loaded_instances?.length ? <><p className="model-load-config">Applied by LM Studio · context {loadedConfig.context_length ?? "default"}{loadedConfig.eval_batch_size ? ` · batch ${loadedConfig.eval_batch_size}` : ""}{typeof loadedConfig.flash_attention === "boolean" ? ` · flash ${loadedConfig.flash_attention ? "on" : "off"}` : ""}{typeof loadedConfig.offload_kv_cache_to_gpu === "boolean" ? ` · GPU KV ${loadedConfig.offload_kv_cache_to_gpu ? "on" : "off"}` : ""}{loadedConfig.num_experts ? ` · experts ${loadedConfig.num_experts}` : ""}</p>{modelLoadNotes[model.key] && <p className="model-load-note">{modelLoadNotes[model.key]}</p>}<button className="secondary-button full-button" disabled={busy} onClick={() => void call("lm:unload", { instanceId: model.loaded_instances[0].id })}>Unload model <span>↓</span></button></> : <><div className="model-load-options"><label>CONTEXT<input aria-label={`Context length for ${model.key}`} type="number" min="1" max={model.maxContext ?? undefined} placeholder="LM default" value={form.contextLength} onChange={(event) => updateModelLoadForm(model.key, "contextLength", event.target.value)}/></label><label>UNLOAD AFTER<input aria-label={`Idle unload TTL seconds for ${model.key}`} type="number" min="1" placeholder="Keep loaded" value={form.ttlSeconds} onChange={(event) => updateModelLoadForm(model.key, "ttlSeconds", event.target.value)}/></label>{supportsLlamaLoadOptions && <label>EVAL BATCH<input aria-label={`Evaluation batch size for ${model.key}`} type="number" min="1" placeholder="LM default" value={form.evalBatchSize} onChange={(event) => updateModelLoadForm(model.key, "evalBatchSize", event.target.value)}/></label>}{supportsLlamaLoadOptions && <><label>FLASH ATTENTION<select aria-label={`Flash Attention for ${model.key}`} value={form.flashAttention} onChange={(event) => updateModelLoadForm(model.key, "flashAttention", event.target.value)}><option value="default">LM default</option><option value="on">Enabled</option><option value="off">Disabled</option></select></label><label>GPU KV CACHE<select aria-label={`GPU KV cache for ${model.key}`} value={form.kvCacheGpu} onChange={(event) => updateModelLoadForm(model.key, "kvCacheGpu", event.target.value)}><option value="default">LM default</option><option value="on">Enabled</option><option value="off">Disabled</option></select></label><label>MOE EXPERTS<input aria-label={`Expert count for ${model.key}`} type="number" min="1" placeholder="LM default" value={form.numExperts} onChange={(event) => updateModelLoadForm(model.key, "numExperts", event.target.value)}/></label><label>GPU LAYERS<select aria-label={`GPU layer offload for ${model.key}`} value={form.gpuOffload} onChange={(event) => updateModelLoadForm(model.key, "gpuOffload", event.target.value)}><option value="default">LM default</option><option value="auto">Auto</option><option value="off">Off</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="max">Max</option></select></label><label>SPECULATIVE<select aria-label="Speculative decoding mode" value={form.draftMode} onChange={(event) => updateModelLoadForm(model.key, "draftMode", event.target.value)}><option value="default">LM default</option><option value="mtp">Draft MTP</option><option value="simple">Simple draft model</option></select></label>{form.draftMode === "simple" && <label>DRAFT MODEL<select aria-label="Speculative draft model" value={form.draftModel} onChange={(event) => updateModelLoadForm(model.key, "draftModel", event.target.value)}><option value="">Select installed model</option>{models.filter((candidate) => candidate.type === "llm" && candidate.key !== model.key).map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.key}</option>)}</select></label>}{form.draftMode !== "default" && <><label>DRAFT MAX TOKENS<input aria-label="Maximum speculative draft tokens" type="number" min="1" placeholder="LM default" value={form.draftMaxTokens} onChange={(event) => updateModelLoadForm(model.key, "draftMaxTokens", event.target.value)}/></label><label>DRAFT MIN TOKENS<input aria-label="Minimum speculative draft tokens" type="number" min="1" placeholder="LM default" value={form.draftMinTokens} onChange={(event) => updateModelLoadForm(model.key, "draftMinTokens", event.target.value)}/></label><label>DRAFT CONTINUE PROBABILITY<input aria-label="Minimum draft continuation probability" type="number" min="0" max="1" step="0.01" placeholder="LM default" value={form.draftMinProbability} onChange={(event) => updateModelLoadForm(model.key, "draftMinProbability", event.target.value)}/></label></>}</>}</div><button className="secondary-button full-button" disabled={busy} onClick={() => void estimateModelLoad(model.key)}>Estimate resources without loading</button>{cliLoadConflict && <p className="model-load-warning">Idle TTL, GPU offload, and speculative decoding use the LM Studio CLI and cannot be combined with REST-only advanced settings in one load.</p>}{draftIncomplete && <p className="model-load-warning">Select an installed draft model for simple speculative decoding.</p>}<button className="secondary-button full-button" disabled={busy || cliLoadConflict || draftIncomplete} onClick={() => void loadModel(model.key)}>Load with these settings <span>↑</span></button></>}</article>; })}</div>{!models.length && <div className="panel empty-page"><h2>No downloaded models were found</h2><p>Start the LM Studio server and refresh to view its local inventory.</p><button className="secondary-button" onClick={() => void call("lm:models")}>Check connection</button></div>}</> : <>
          <section className="panel hf-search-panel"><div><div className="eyebrow small-eyebrow">HUGGING FACE HUB</div><h2>Discover a model</h2><p>Search model names, publishers, or capabilities. Search requires online discovery to be enabled.</p></div><form className="hf-search-form" onSubmit={(event) => void searchHuggingFace(event)}><input value={hfQuery} onChange={(event) => setHfQuery(event.target.value)} placeholder="e.g. Qwen coder GGUF" aria-label="Search Hugging Face models"/><button className="primary-button" disabled={busy || !hfQuery.trim()}>Search <b>⌕</b></button><button type="button" className="secondary-button" disabled={busy || !hfQuery.trim()} onClick={() => void recommendHuggingFace()}>Recommend fit <b>⌁</b></button></form></section>
          {hfRecommendations.length > 0 && <section className="hf-recommendations"><div className="eyebrow small-eyebrow">RESOURCE-AWARE PICKS · ESTIMATES ONLY</div>{hfRecommendations.map((pick) => <article className="panel hf-result recommendation-card" key={`${pick.repository}-${pick.artifact}`}><div className="hf-result-copy"><span className="model-badge">{pick.quantization} · {formatBytes(pick.sizeBytes)} · {pick.license ?? "LICENSE UNKNOWN"}</span><h3>{pick.repository}</h3><p>{pick.artifact} · estimated memory {formatBytes(pick.estimatedMemoryBytes)} · revision {String(pick.revision).slice(0, 10)}</p><small className={pick.licenseAllowed ? "disk-preflight-ok" : "disk-preflight-low"}>Automatic acquisition: {pick.licenseAllowed ? "license preference allows this tag" : "blocked by saved license preferences"}</small><small>{pick.reason}</small>{Array.isArray(pick.publishedEvaluationEvidence) && pick.publishedEvaluationEvidence.map((evidence: Record<string, unknown>, index: number) => <small key={index}>Hub-listed evaluation (verify source): {String(evidence.dataset ?? "dataset unspecified")} · {String(evidence.metric ?? "metric unspecified")} {evidence.value === undefined ? "" : `· ${String(evidence.value)}`} {evidence.source ? `· ${String(evidence.source)}` : ""} {evidence.sourceUrl ? `· ${String(evidence.sourceUrl)}` : ""}</small>)}<small className={pick.diskSufficient ? "disk-preflight-ok" : "disk-preflight-low"}>Model directory free {formatBytes(pick.diskAvailableBytes)} · temporary volume free {formatBytes(pick.tempDiskAvailableBytes)} · each needs {formatBytes(pick.diskRequiredBytes)} · {pick.diskSufficient ? "sufficient" : "insufficient"}</small></div><button className="secondary-button" disabled={busy || !snapshot.settings?.downloads?.value || !pick.diskSufficient} title={snapshot.settings?.downloads?.value ? "Download recommended model" : "Enable model downloads in Settings first"} onClick={() => void call("hf:download", { repository: pick.repository, quantization: pick.quantization })}>Download fit <span>↓</span></button></article>)}</section>}\n          {hfResults.length > 0 && <div className="hf-results">{hfResults.map((model) => { const choices = deriveQuantizations(model.files ?? []); const selected = quantizations[model.id] ?? choices[0] ?? ""; return <article className="panel hf-result" key={model.id}><div className="hf-result-copy"><div className="model-card-top"><span className="model-badge">{model.license ?? "LICENSE UNKNOWN"}</span><span className="downloads-count">↓ {Number(model.downloads ?? 0).toLocaleString()}</span></div><h3>{model.id}</h3><p>{model.pipeline ?? "Model"} · {model.gated ? "Gated access" : "Public"} · {model.revision?.slice(0, 10) ?? "main"}</p></div><label className="quant-select">QUANTIZATION<select value={selected} onChange={(event) => setQuantizations((current) => ({ ...current, [model.id]: event.target.value }))}>{choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></label><button className="secondary-button" disabled={busy || !selected || model.gated || model.private} onClick={() => void call("hf:download", { repository: model.id, quantization: selected })}>Download <span>↓</span></button></article>; })}</div>}
          <section className="panel download-panel"><div className="panel-head"><div><div className="eyebrow small-eyebrow">TRANSFER QUEUE</div><h2>Model downloads</h2></div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh downloads">↻</button></div>{downloads.length ? <div className="download-list">{downloads.map((job) => { let details: Record<string, any> = {}; try { details = typeof job.details_json === "string" ? JSON.parse(job.details_json) : job.details_json ?? {}; } catch { /* ignore malformed legacy job details */ } const capabilityCheck = details.capabilityCheck as Record<string, any> | undefined; return <div className="download-row" key={job.id}><span className={`download-state ${statusClass(job.state)}`}><i/>{job.state}</span><div><strong>{job.repository}</strong><span>{job.quantization ?? "Default quantization"} · {formatBytes(job.total_size_bytes)}{capabilityCheck ? ` · inference check ${capabilityCheck.status}` : ""}</span></div><button className="row-action" onClick={() => void call("hf:status", { id: job.id })}>Check ↻</button>{["completed", "already_downloaded"].includes(String(job.state)) && capabilityCheck?.status !== "passed" && <button className="row-action" disabled={busy} title="Load briefly when safe and run a small inference check" onClick={() => void call("hf:verify-download", { id: job.id })}>Verify model</button>}</div>; })}</div> : <div className="download-empty">No model download jobs yet.</div>}</section>
        </>}
      </section>}

      {view === "changes" && <ChangesView onAction={call} busy={busy}/>}
      {view === "memory" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>LOCAL CONTEXT</div><h1>Saved <em>memory.</em></h1><p>Review the preferences and notes Xyst can search during future tasks.</p></div><button className="refresh-button" onClick={() => void refresh()}>↻ Refresh</button></div><section className="panel memory-compose"><div><div className="eyebrow small-eyebrow">ADD A MEMORY</div><h2>Save a preference or note</h2><p>Only save details you want Xyst to remember. Inferred notes stay separate from explicit preferences. Credentials are rejected.</p></div><form className="memory-form" onSubmit={(event) => { event.preventDefault(); void call("memory:add", { kind: memoryKind, content: memoryContent }).then((result) => { if (result) setMemoryContent(""); }); }}><select value={memoryKind} onChange={(event) => setMemoryKind(event.target.value as "preference" | "note" | "inferred")} aria-label="Memory type"><option value="preference">Preference</option><option value="note">Note</option><option value="inferred">Inferred note</option></select><textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} maxLength={20000} rows={2} placeholder="What should Xyst remember?" aria-label="Memory content"/><button className="primary-button" disabled={busy || !memoryContent.trim()}>Save memory <b>＋</b></button></form></section><div className="memory-toolbar"><label>Search memories<input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="Filter saved context"/></label><span>{snapshot.memories.length} saved</span></div><div className="memory-list">{snapshot.memories.filter((memory) => `${memory.kind} ${memory.content} ${memory.source}`.toLowerCase().includes(memoryQuery.toLowerCase())).map((memory) => <article className="panel memory-card" key={memory.id}><div className="memory-card-head"><span className="model-badge">{memory.kind}</span><small>{memory.source} · {new Date(memory.updated_at).toLocaleString()}</small></div>{editingMemory === memory.id ? <><textarea value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} maxLength={20000} rows={3} aria-label="Edit memory"/><div className="memory-actions"><button className="secondary-button" onClick={() => setEditingMemory(null)}>Cancel</button><button className="primary-button" disabled={busy || !memoryDraft.trim()} onClick={() => void call("memory:edit", { id: memory.id, content: memoryDraft }).then((result) => { if (result) setEditingMemory(null); })}>Save changes</button></div></> : <><p>{memory.content}</p><div className="memory-actions"><button className="secondary-button" onClick={() => { setEditingMemory(memory.id); setMemoryDraft(memory.content); }}>Edit</button><button className="danger-button" disabled={busy} onClick={() => void call("memory:delete", { id: memory.id })}>Delete</button></div></>}</article>)}</div>{!snapshot.memories.length && <div className="panel empty-page"><div className="empty-glyph">✧</div><h2>No memories saved</h2><p>Add a preference or note when you want Xyst to retain it.</p></div>}</section>}

      {view === "github" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>INTEGRATION BRIDGE</div><h1>GitHub <em>bridge.</em></h1><p>Control the account connection and integration permissions used by missions.</p></div></div><GitHubPanel onAction={call}/></section>}

      {view === "settings" && <section className="content page-content"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>SYSTEM CONFIGURATION</div><h1>System <em>settings.</em></h1><p>Runtime settings apply at the boundary listed in the timing reference. Appearance preferences are saved locally and apply immediately.</p></div><button className="secondary-button" onClick={() => { if (window.confirm("Clear all global Xyst configuration overrides? Scoped overrides and appearance preferences stay in place.")) void call("setting:reset-global"); }}>Reset global defaults</button></div><details className="panel settings-panel settings-timing-reference"><summary>Runtime setting apply timing</summary><ul>{scopedSettingKeys.map((settingKey) => <li key={settingKey}><code>{settingKey}</code><span>{settingApplyWhen[settingKey]}</span></li>)}</ul><p className="settings-foot">Appearance preferences apply immediately on this device. Installing a downloaded update requires a restart.</p></details><div className="settings-layout"><ScopedSettings busy={busy} onInspect={(key, scope, scopeId, contextMissionId) => call("config:scoped-inspect", { key, scope, scopeId, contextMissionId })} onSave={(key, scope, scopeId, value) => call("config:scoped-set", { key, scope, scopeId, value })} onReset={(key, scope, scopeId) => call("config:scoped-reset", { key, scope, scopeId })}/><InferenceSettings settings={snapshot.settings?.inference} onApply={setInferenceSettings}/><ParallelReadSettings setting={snapshot.settings?.maxParallelReads} onChange={setParallelReadLimit}/><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">NETWORK POLICY</div><h2>Network access</h2></div></div><ToggleRow title="Network connections" description="Allow Xyst to connect to LM Studio, Hugging Face, web search, public HTTP/JSON APIs, and configured remote services for live data. Restricted profiles can impose tighter limits." value={Boolean(snapshot.settings?.networkEnabled?.value ?? true)} source={snapshot.settings?.networkEnabled?.source} onChange={(enabled) => void call("setting:network", { enabled })}/><p className="settings-foot">This global control takes effect on the next CLI or agent operation. Enabling it does not override a restricted access profile.</p></section><AccessProfileSettings setting={snapshot.settings?.accessProfile ?? { value: { mode: "full" }, source: "runtime default" }} onApply={(profile) => call("setting:access-profile", { profile })}/><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">GITHUB PERMISSIONS</div><h2>Integration access</h2></div></div><ToggleRow title="GitHub integration" description="Allow agent GitHub read tools when credentials and repository access are available." value={Boolean(snapshot.settings?.githubEnabled?.value)} source={snapshot.settings?.githubEnabled?.source} onChange={(enabled) => void call("setting:github", { key: "integrations.github.enabled", enabled })}/><ToggleRow title="GitHub writes" description="Allow comments and pull request creation, subject to mission and access policy." value={Boolean(snapshot.settings?.githubWrites?.value)} source={snapshot.settings?.githubWrites?.source} onChange={(enabled) => void call("setting:github", { key: "integrations.github.writeEnabled", enabled })}/><ToggleRow title="Mission-authorized merges" description="Permit merge operations only when a mission explicitly authorizes merging." value={Boolean(snapshot.settings?.githubMerge?.value)} source={snapshot.settings?.githubMerge?.source} onChange={(enabled) => void call("setting:github", { key: "integrations.github.mergeEnabled", enabled })}/><p className="settings-foot">Write and merge controls do not grant repository permissions or bypass the active access profile.</p></section><GitHubServerSettings setting={snapshot.settings?.githubApiBaseUrl ?? { value: "", source: "runtime default" }} onSave={(value) => call("setting:github", { key: "integrations.github.apiBaseUrl", value })}/><McpSettings enabled={snapshot.settings?.mcpEnabled ?? { value: false, source: "runtime default" }} servers={snapshot.settings?.mcpServers ?? { value: [], source: "runtime default" }} onSave={(value) => call("setting:mcp", value)}/><NativeChatMcpSettings enabled={snapshot.settings?.nativeChatMcpEnabled ?? { value: false, source: "runtime default" }} integrations={snapshot.settings?.nativeChatMcpIntegrations ?? { value: [], source: "runtime default" }} onSave={(value) => call("setting:native-chat-mcp", value)}/><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">MODEL POLICY</div><h2>Discovery and selection</h2></div></div><DefaultModelSettings setting={snapshot.settings?.defaultModel} models={snapshot.models ?? []} onSave={(model) => call("setting:model-default", { model })}/><ToggleRow title="Automatic model selection" description="Choose a suitable installed model when an agent starts." value={Boolean(snapshot.settings?.autoSelect?.value)} source={snapshot.settings?.autoSelect?.source} onChange={(value) => void setModelSetting("auto", value)}/><ToggleRow title="Automatic model loading" description="Preload unloaded local models before agent runs. Remote LM Studio servers use their documented just-in-time loader." value={Boolean(snapshot.settings?.automaticLoading?.value ?? true)} source={snapshot.settings?.automaticLoading?.source} onChange={(value) => void setModelSetting("loading", value)}/><ToggleRow title="Automatic idle unloading" description="Set an idle time-to-live for models Xyst loads and eligible just-in-time requests. Models already loaded outside Xyst are left alone." value={Boolean(snapshot.settings?.automaticUnloading?.value)} source={snapshot.settings?.automaticUnloading?.source} onChange={(value) => void setModelSetting("unloading", value)}/><label className="model-select-label">MODEL IDLE TIME-TO-LIVE<select aria-label="Model idle unload time" value={String(snapshot.settings?.idleUnloadSeconds?.value ?? 3600)} onChange={(event) => void call("setting:model-idle-unload", { seconds: Number(event.target.value) })}>{[300,600,900,1800,3600,7200,14400,86400].map((seconds) => <option key={seconds} value={seconds}>{seconds < 3600 ? `${seconds / 60} minutes` : seconds % 3600 === 0 ? `${seconds / 3600} hours` : `${seconds} seconds`}</option>)}</select><small className="setting-source">Effective source · {snapshot.settings?.idleUnloadSeconds?.source ?? "runtime default"}</small></label><ToggleRow title="Online Hugging Face discovery" description="Allow Hub search and model metadata requests." value={Boolean(snapshot.settings?.discovery?.value)} source={snapshot.settings?.discovery?.source} onChange={(value) => void setModelSetting("discovery", value)}/><ToggleRow title="Model downloads" description="Allow explicit LM Studio downloads and automatic agent acquisition when its license is on your allow-list." value={Boolean(snapshot.settings?.downloads?.value)} source={snapshot.settings?.downloads?.source} onChange={(value) => void setModelSetting("downloads", value)}/><ModelDownloadLimitSettings setting={snapshot.settings?.modelMaxDownloadBytes} onSave={(bytes) => call("setting:model-max-download", { bytes })}/><ModelLicenseSettings setting={snapshot.settings?.modelAllowedLicenses} onSave={(licenses) => call("setting:model-license-preferences", { licenses })}/><ToggleRow title="Remote provider fallback" description="Offer a remote LM Studio model after local inference fails. Xyst asks for explicit approval before sending this run's context." value={Boolean(snapshot.settings?.remoteFallback?.value)} source={snapshot.settings?.remoteFallback?.source} onChange={(value) => void setModelSetting("remote-fallback", value)}/><RemoteFallbackSettings endpoint={String(snapshot.settings?.remoteFallbackUrl?.value ?? "")} model={String(snapshot.settings?.remoteFallbackModel?.value ?? "")} endpointSource={snapshot.settings?.remoteFallbackUrl?.source} modelSource={snapshot.settings?.remoteFallbackModel?.source} onApply={(endpoint, model) => call("setting:model-remote-config", { endpoint, model })}/><p className="settings-foot">Remote use also requires network and external-action access. Store an optional API token with <code>xyst credential set lm-studio-remote-fallback api-token</code>. Mission and headless runs fail closed because they cannot obtain this one-run consent.</p><ToggleRow title="Automatic model switching" description="Switch once to another installed local model after repeated inference failure." value={Boolean(snapshot.settings?.switching?.value)} source={snapshot.settings?.switching?.source} onChange={(value) => void setModelSetting("switching", value)}/><ToggleRow title="Local inference measurements" description="Store latency, token counts, and success/failure totals only in this Xyst database. Used to guide automatic model selection; never uploaded." value={Boolean(snapshot.settings?.localMetrics?.value ?? true)} source={snapshot.settings?.localMetrics?.source} onChange={(value) => void call("setting:local-metrics", { enabled: value })}/><div className="panel-title"><div><div className="eyebrow small-eyebrow">BROWSER AUTOMATION</div><h2>Persistent browser</h2></div></div><ToggleRow title="Browser automation" description="Expose Playwright Chromium tools to agent runs. Browser actions use a separate persistent profile." value={Boolean(snapshot.settings?.browserAutomation?.value)} source={snapshot.settings?.browserAutomation?.source} onChange={(enabled) => void call("setting:browser-automation", { enabled })}/><ToggleRow title="Run browser headless" description="Hide the Chromium window during automated tasks. Applies to the next agent run." value={Boolean(snapshot.settings?.browserHeadless?.value ?? true)} source={snapshot.settings?.browserHeadless?.source} onChange={(enabled) => void call("setting:browser-headless", { enabled })}/><BrowserDownloadLimitSettings setting={snapshot.settings?.browserMaxDownloadBytes} onSave={(bytes) => call("setting:browser-max-download", { bytes })}/><p className="settings-foot">{snapshot.browser?.installed ? `Playwright Chromium is installed at ${snapshot.browser.executablePath}.` : "Playwright Chromium is not installed. Install it to enable page automation."} Browser status: {snapshot.browser?.installed ? "ready" : "installation required"}.</p><button className="secondary-button" disabled={busy || snapshot.browser?.installed === true} onClick={() => void call("browser:install")}>Install Chromium</button></section><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">RESOURCE LIMITS</div><h2>Mission scheduling</h2></div></div><ToggleRow title="Scheduled mission triggers" description="Enable or pause cron schedules across missions. Re-enabling applies each mission's missed-run policy." value={Boolean(snapshot.settings?.missionScheduling?.value ?? true)} source={snapshot.settings?.missionScheduling?.source} onChange={(enabled) => void call("setting:mission-scheduling", { enabled })}/><ToggleRow title="Agent delegation" description="Allow generated plans and missions to use multiple tasks or named agent roles. When disabled, one-task plans remain available." value={Boolean(snapshot.settings?.delegationEnabled?.value ?? true)} source={snapshot.settings?.delegationEnabled?.source} onChange={(enabled) => void call("setting:delegation", { enabled })}/><ToggleRow title="Approve external actions" description="Ask once before each external write or browser mutation. Headless mission runs stop safely when approval is required." value={Boolean(snapshot.settings?.externalActionApproval?.value)} source={snapshot.settings?.externalActionApproval?.source} onChange={(enabled) => void call("setting:external-approval", { enabled })}/><ToggleRow title="Automatic mission retries" description="Retry failed mission tasks within each mission retry limit. Manual retries remain available when disabled." value={Boolean(snapshot.settings?.automaticRetries?.value ?? true)} source={snapshot.settings?.automaticRetries?.source} onChange={(enabled) => void call("setting:automatic-retries", { enabled })}/><label className="model-select-label">GLOBAL CONCURRENCY CEILING<select aria-label="Maximum concurrent mission tasks" value={maxConcurrencyChoice} onChange={(event) => setConcurrencyLimit(event.target.value)}>{[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value} task{value === 1 ? "" : "s"}</option>)}</select></label><label className="model-select-label">ADDITIONAL MEMORY BUDGET<select aria-label="Mission memory budget" value={memoryBudgetChoice} onChange={(event) => setResourceBudget(event.target.value)}><option value="auto">Automatic · current available memory</option>{memoryBudgetChoices.map((gib) => <option key={gib} value={gib * 1024 ** 3}>{gib} GiB</option>)}</select></label><p className="settings-foot">Changes apply at the next mission scheduling wave. The memory budget is an estimate for model loading and parallel inference; it does not measure GPU VRAM. Project and mission settings can override these global values.</p></section><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">MEMORY RETRIEVAL</div><h2>Semantic search</h2></div></div><ToggleRow title="LM Studio embedding search" description="Rank saved memories by meaning. Search falls back to text matching if embeddings are unavailable." value={Boolean(snapshot.settings?.memorySemantic?.value)} source={snapshot.settings?.memorySemantic?.source} onChange={(enabled) => void call("setting:memory-semantic", { enabled, model: selectedEmbeddingModel })}/><label className="model-select-label">EMBEDDING MODEL<select aria-label="Memory embedding model" value={embeddingModelSelectValue} onChange={(event) => setEmbeddingModelChoice(event.target.value)}><option value="__auto__">Automatically select a suitable installed model</option>{embeddingModels.map((model) => <option key={model.key} value={model.key}>{model.display_name ?? model.key}</option>)}</select></label><div className="memory-actions"><button className="secondary-button" disabled={busy || (!selectedEmbeddingModel && snapshot.settings?.autoSelect?.value === false)} onClick={() => void call("setting:memory-semantic", { enabled: true, model: selectedEmbeddingModel })}>{selectedEmbeddingModel ? "Use selected model" : "Use automatic selection"}</button><button className="secondary-button" disabled={busy || (!selectedEmbeddingModel && snapshot.settings?.autoSelect?.value === false)} onClick={() => void call("memory:index", { model: selectedEmbeddingModel }).then((result) => setMemoryIndexMessage(result ? `Indexed ${result.indexed} memories with ${result.model}.` : ""))}>Index saved memories</button></div>{memoryIndexMessage && <p className="settings-foot" role="status">{memoryIndexMessage}</p>}<p className="settings-foot">Selected model source: {snapshot.settings?.embeddingModel?.source ?? "not configured"}. Indexing uses the local LM Studio embedding API.</p></section><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">DESKTOP NOTIFICATIONS</div><h2>Run alerts</h2></div></div><ToggleRow title="Desktop notifications" description="Show a native system notification when an agent or mission run completes or fails, including CLI and scheduled mission runs. Headless delivery requires an interactive user notification session." value={Boolean(snapshot.settings?.notificationsEnabled?.value)} source={snapshot.settings?.notificationsEnabled?.source} onChange={(enabled) => void call("setting:notifications", { enabled })}/><p className="settings-foot">Notifications are opt-in and do not include task content or error details.</p></section><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">NATIVE APPLICATION AUTOMATION</div><h2>Desktop controls</h2></div></div><ToggleRow title="Enable native application automation" description="Expose Windows UI Automation or X11/Xwayland window controls to agent runs. Changes to another app are external actions and follow your approval setting." value={Boolean(snapshot.settings?.desktopAutomation?.value)} source={snapshot.settings?.desktopAutomation?.source} onChange={(enabled) => void call("setting:desktop-automation", { enabled })}/><p className="settings-foot">Wayland native surfaces and applications without accessible UI controls may be unavailable. This setting applies to the next agent run.</p></section><OfficeRendererSettings setting={snapshot.settings?.officeRendererExecutable ?? { value: "", source: "runtime default" }} onSave={(executable) => call("setting:office-renderer", { executable })}/><OcrLanguageSettings setting={snapshot.settings?.ocrLanguages ?? { value: ["eng"], source: "runtime default" }} onSave={(languages) => call("setting:ocr-languages", { languages })}/><UpdateSettings settings={snapshot.settings ?? {}} state={updateState} onSetting={(key, value) => call("setting:updates", { key, value })} onAction={(action) => call(action)}/><section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">ACCESSIBILITY & PRESENTATION</div><h2>Appearance</h2></div></div><ToggleRow title="Reduced motion" description="Reduce animated gradients and transitions." value={prefs.reducedMotion} onChange={() => setPreference("reducedMotion")}/><ToggleRow title="Interface animations" description="Enable subtle control and panel transitions." value={prefs.animations} onChange={() => setPreference("animations")}/><ToggleRow title="Decorative effects" description="Show ambient lighting and robot glow effects." value={prefs.decorativeEffects} onChange={() => setPreference("decorativeEffects")}/><ToggleRow title="Robot presentation" description="Show the Xyst robot identity and status panel." value={prefs.robotPresentation} onChange={() => setPreference("robotPresentation")}/><ToggleRow title="High contrast" description="Increase borders and text contrast." value={prefs.highContrast} onChange={() => setPreference("highContrast")}/><ToggleRow title="Larger text" description="Increase interface text size." value={prefs.largeText} onChange={() => setPreference("largeText")}/><ToggleRow title="Sound alerts" description="Play a brief local chime when a mission or background job completes or fails. Disabled by default." value={prefs.soundAlerts} onChange={() => setPreference("soundAlerts")}/><label className="model-select-label">ACCENT COLOR<select aria-label="Accent color" value={prefs.accent} onChange={(event) => setAccent(event.target.value)}><option value="green">Alien green</option><option value="cyan">Cyan</option><option value="violet">Violet</option></select></label><p className="settings-foot">Appearance options are saved locally and apply immediately.</p></section></div></section>}
      </div>}
      {!layout.centerPanel && <div className="center-workspace-hidden">Center workspace hidden. Restore it from the Panels menu.</div>}
      {layout.activityPanel && <section className="activity-dock" aria-label="Recent execution activity">
        <div className="activity-dock-heading"><div><span>BOTTOM DOCK</span><strong>Recent execution</strong></div><div><button type="button" onClick={() => setView("jobs")}>All jobs</button><button type="button" onClick={() => setView("terminal")}>Terminal</button></div></div>
        <div className="activity-dock-list">{jobs.length ? jobs.slice(0, 3).map((job) => <button type="button" className="activity-job" key={`${job.kind}:${job.id}`} onClick={() => setView("jobs")}><span>{job.kind} <i>·</i> {job.state}</span><small>{job.updated_at ? new Date(job.updated_at).toLocaleString() : "Saved job"}</small></button>) : <span className="activity-dock-empty">No saved jobs yet. Completed work appears here.</span>}</div>
      </section>}
      {layout.statusBar && <footer className={`statusbar ${runtimeState}`}><span><i/> XYST RUNTIME · {runtimeState === "checking" ? "CHECKING" : runtimeReady ? "READY" : "UNAVAILABLE"}</span><span>{String(status.dataDir ?? "LOCAL STATE")}</span><span>SHARED WITH CLI</span></footer>}
    </main>

    {layout.contextPanel && <aside className="context-panel" aria-label="Workspace context">
      <div className="context-panel-heading"><div><span>CONTROL CONTEXT</span><h2>Live state</h2></div><RobotMark/></div>
      <section className="context-fact"><span>RUNTIME</span><strong className={`context-runtime ${runtimeState}`}>{runtimeLabel}</strong><small>{String(status.dataDir ?? "Local state")}</small></section>
      <section className="context-fact"><span>ACTIVE VIEW</span><strong>{viewOptions.find(([key]) => key === view)?.[1] ?? "Overview"}</strong></section>
      <section className="context-fact"><span>ACCESS PROFILE</span><strong>{profileLabel}</strong></section>
      <section className="context-fact"><span>LOCAL MODEL</span><strong>{currentModel}</strong><small>{snapshot.modelsError ? "Inventory unavailable" : `${loadedCount} loaded · ${models.length} available`}</small></section>
      <section className="context-fact"><span>SELECTED SESSION</span><strong>{selectedSession?.title ?? "None selected"}</strong><small>{agentRunning ? "Agent task active" : `${agents.length} saved agent${agents.length === 1 ? "" : "s"}`}</small></section>
      <div className="context-quick-links"><button type="button" onClick={() => setView("models")}>Model dock <span>↗</span></button><button type="button" onClick={() => setView("agents")}>Agents <span>↗</span></button><button type="button" onClick={() => setView("settings")}>Settings <span>↗</span></button></div>
    </aside>}

    {showMissionEditor && <div className="modal-backdrop" role="presentation" onClick={() => setShowMissionEditor(false)}><section className="mission-modal" role="dialog" aria-modal="true" aria-labelledby="mission-title" onClick={(event) => event.stopPropagation()}><div className="modal-top"><div><div className="eyebrow small-eyebrow">NEW AUTOMATION</div><h2 id="mission-title">Create a mission</h2></div><button className="icon-button" onClick={() => setShowMissionEditor(false)} aria-label="Close">×</button></div><p>Draft a local model task graph, review and edit its JSON, then save when ready. Templates remain editable; external GitHub writes stay disabled unless enabled in the definition.</p><label className="mission-plan-objective">PLAN FROM OBJECTIVE<textarea value={missionObjective} onChange={(event) => setMissionObjective(event.target.value)} maxLength={8000} placeholder="Describe the outcome and useful checks" aria-label="Mission planning objective"/></label><button className="secondary-button" disabled={busy || !missionObjective.trim()} onClick={() => void planMission()}>Generate draft plan</button><div className="mission-template-row"><label>STARTER WORKFLOW<select value={missionTemplateId} onChange={(event) => setMissionTemplateId(event.target.value)} aria-label="Mission workflow template">{missionTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><button className="secondary-button" disabled={busy || missionTemplates.length === 0} onClick={() => void loadMissionTemplate()}>Load template</button></div><textarea className="json-editor" value={missionJson} onChange={(event) => setMissionJson(event.target.value)} spellCheck={false} aria-label="Mission definition JSON" placeholder={'{\n  "name": "Repository health check",\n  "objective": "Inspect the repository and report issues.",\n  "maxRetries": 1\n}'}/><div className="modal-actions"><button className="secondary-button" onClick={() => setShowMissionEditor(false)}>Cancel</button><button className="primary-button" disabled={busy || !missionJson.trim()} onClick={() => void createMission()}>Save mission <b>↗</b></button></div></section></div>}
  </div>;
}

function ChangesView({ onAction, busy }: { onAction: (action: string, payload?: unknown) => Promise<any>; busy: boolean }) {
  const [data, setData] = useState<{ status?: string; diff?: string; history?: string; workspace?: string } | null>(null);
  const [staged, setStaged] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setError("");
    try {
      const result = await onAction("git:changes", { staged });
      if (result) setData(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const chooseWorkspace = async () => {
    setError("");
    try {
      const result = await onAction("git:pick-workspace");
      if (result && !result.cancelled) await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  useEffect(() => { void refresh(); }, [staged]);
  return <section className="content page-content changes-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>WORKSPACE INSPECTOR</div><h1>Repository <em>changes.</em></h1><p>Review working tree status, diffs, and recent commits for the current workspace.</p></div><div className="changes-heading-actions"><button className="secondary-button" disabled={busy} onClick={() => void chooseWorkspace()}>Choose repository</button><button className="refresh-button" disabled={busy} onClick={() => void refresh()}>↻ Refresh</button></div></div>
    <div className="changes-toolbar"><div className="model-tabs"><button className={!staged ? "selected" : ""} onClick={() => setStaged(false)}>Working tree</button><button className={staged ? "selected" : ""} onClick={() => setStaged(true)}>Staged diff</button></div><span title={data?.workspace}>{data?.workspace ?? "Choose a local repository"} · READ ONLY · {staged ? "INDEX" : "WORKTREE"}</span></div>
    {error && <div className="notice-line model-error" role="alert">Could not inspect this workspace: {error}</div>}
    <div className="changes-grid"><section className="panel changes-pane"><div className="panel-title"><div><div className="eyebrow small-eyebrow">GIT STATUS</div><h2>Working tree</h2></div></div><pre>{data?.status ?? (error ? "" : "Loading status…")}</pre></section><section className="panel changes-pane"><div className="panel-title"><div><div className="eyebrow small-eyebrow">{staged ? "STAGED DIFF" : "UNSTAGED DIFF"}</div><h2>{staged ? "Index changes" : "Current diff"}</h2></div></div><pre>{data?.diff || (error ? "" : "No diff content.")}</pre></section><section className="panel changes-pane changes-history"><div className="panel-title"><div><div className="eyebrow small-eyebrow">RECENT HISTORY</div><h2>Latest commits</h2></div></div><pre>{data?.history ?? (error ? "" : "Loading history…")}</pre></section></div>
  </section>;
}


function EventLine({ event }: { event: AgentEvent }) {
  const kind = String(event.event ?? event.type ?? "event").replaceAll(".", " "); const data = event.data ?? {};
  const body = typeof data.text === "string" ? data.text : typeof data.name === "string" ? `${data.name}${data.error ? ` · ${data.error}` : ""}` : data.model ? `${data.model} · ${data.reason ?? "selected"}` : JSON.stringify(data);
  return <div className={`event-line ${kind.includes("failed") ? "event-error" : ""}`}><i/> <span className="event-kind">{kind}</span><span className="event-body">{body}</span></div>;
}

function MissionRow({ mission, onAction }: { mission: Record<string, any>; onAction: (action: string, payload: unknown) => Promise<any> }) {
  return <div className="mission-row"><span className="mission-symbol">⎇</span><div className="mission-info"><strong>{mission.definition?.name ?? mission.id}</strong><span>{mission.definition?.tasks?.length ?? 1} steps · {mission.definition?.schedule?.enabled ? `Scheduled · ${mission.definition.schedule.timezone}` : "Manual trigger"}</span></div><span className={`status-pill ${statusClass(mission.status)}`}>{mission.status}</span><button className="row-action" onClick={() => void onAction(mission.status === "paused" ? "mission:resume" : "mission:run", { id: mission.id })}>{mission.status === "paused" ? "Resume" : "Run"} ↗</button></div>;
}

function MissionCard({ mission, onAction }: { mission: Record<string, any>; onAction: (action: string, payload: unknown) => Promise<any> }) {
  const action = (verb: string) => void onAction(`mission:${verb}`, { id: mission.id });
  const manage = async (verb: "rename" | "fork" | "export" | "delete") => {
    const name = String(mission.definition?.name ?? mission.id);
    if (verb === "rename") {
      const nextName = window.prompt("Mission name", name);
      if (nextName === null || !nextName.trim()) return;
      await onAction("mission:rename", { id: mission.id, name: nextName.trim() });
    } else if (verb === "fork") {
      const forkName = window.prompt("Fork mission name", `${name} (fork)`);
      if (forkName === null || !forkName.trim()) return;
      await onAction("mission:fork", { id: mission.id, name: forkName.trim() });
    } else if (verb === "export") {
      await onAction("mission:export", { id: mission.id });
    } else if (window.confirm(`Permanently delete “${name}” and its mission run history? Task sessions and saved artifacts will remain.`)) {
      await onAction("mission:delete", { id: mission.id });
    }
  };
  return <article className="panel mission-card"><div className="mission-card-head"><span className="mission-symbol">⎇</span><span className={`status-pill ${statusClass(mission.status)}`}>{mission.status}</span><button className="icon-button" aria-label="Inspect mission" onClick={() => void onAction("mission:show", { id: mission.id })}>···</button></div><h2>{mission.definition?.name ?? mission.id}</h2><p>{mission.definition?.objective}</p><div className="mission-card-meta"><span>{mission.definition?.tasks?.length ?? 1} task(s)</span><span>{mission.definition?.schedule?.enabled ? mission.definition.schedule.cron : "Manual"}</span><span>Updated {new Date(mission.updated_at).toLocaleDateString()}</span></div><div className="mission-card-actions">{mission.status === "paused" || mission.status === "interrupted" ? <button className="primary-button" onClick={() => action("resume")}>Resume <b>↻</b></button> : <button className="primary-button" disabled={mission.status === "running" || mission.status === "archived"} onClick={() => action("run")}>Run now <b>↗</b></button>}{mission.status === "running" ? <button className="secondary-button" onClick={() => action("pause")}>Pause</button> : <button className="secondary-button" disabled={mission.status === "archived"} onClick={() => action("archive")}>Archive</button>}</div><div className="mission-manage-actions"><button className="row-action" disabled={mission.status === "running"} onClick={() => void manage("rename")}>Rename</button><button className="row-action" onClick={() => void manage("fork")}>Fork</button><button className="row-action" onClick={() => void manage("export")}>Export</button><button className="row-action danger-action" disabled={mission.status === "running"} onClick={() => void manage("delete")}>Delete</button></div></article>;
}

function GitHubPanel({ onAction }: { onAction: (action: string, payload?: unknown) => Promise<any> }) {
  const [connection, setConnection] = useState<Record<string, any> | null>(null);
  const [repositories, setRepositories] = useState<Array<Record<string, any>>>([]);
  const [repository, setRepository] = useState("");
  const [repoQuery, setRepoQuery] = useState("");
  const [tab, setTab] = useState<"issues" | "prs">("issues");
  const [items, setItems] = useState<Array<Record<string, any>>>([]);
  const [itemState, setItemState] = useState<"open" | "closed" | "all">("open");
  const refreshStatus = async () => { const value = await onAction("github:status"); setConnection(value ?? null); };
  const findRepos = async (query = "") => { const value = await onAction("github:repos", { query }); if (Array.isArray(value)) setRepositories(value); };
  const loadItems = async (fullName = repository, selectedTab = tab, state = itemState) => {
    if (!fullName) { setItems([]); return; }
    const value = await onAction(selectedTab === "issues" ? "github:issues" : "github:prs", { repository: fullName, state });
    if (Array.isArray(value)) setItems(value);
  };
  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => { void loadItems(); }, [repository, tab, itemState]);
  return <div className="github-workspace"><section className="panel github-panel"><div className="github-emblem">⌘</div><div className="github-copy"><div className="eyebrow small-eyebrow">PERSONAL TOKEN OR GITHUB APP</div><h2>Repository integration</h2><p>Browse repositories, issues, and pull requests available to the configured GitHub account.</p><div className="github-status"><span className={connection?.authenticated ? "online-dot" : "github-dot-off"}/>{connection?.authenticated ? `Connected${connection.login ? ` as ${connection.login}` : ""}` : connection?.message ?? connection?.error ?? "No account connection detected"}</div><small>Set a credential with <code>github auth set</code> and configure access in System Settings. Secrets stay in the operating system credential vault.</small></div><button className="secondary-button" onClick={() => void refreshStatus()}>Refresh status <span>↻</span></button></section>
    <section className="panel github-browser"><div className="panel-head"><div><div className="eyebrow small-eyebrow">REPOSITORIES</div><h2>Issues and pull requests</h2></div><button className="icon-button" onClick={() => void loadItems()} aria-label="Refresh GitHub items">↻</button></div><form className="github-repo-search" onSubmit={(event) => { event.preventDefault(); void findRepos(repoQuery.trim()); }}><input value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} placeholder="Search repositories" aria-label="Search GitHub repositories"/><button className="secondary-button">Search</button><button type="button" className="text-button" onClick={() => void findRepos()}>My repositories</button></form><label className="quant-select github-repo-select">SELECT REPOSITORY<select value={repository} onChange={(event) => setRepository(event.target.value)}><option value="">Choose an accessible repository</option>{repositories.map((item) => <option key={item.full_name} value={item.full_name}>{item.full_name}</option>)}</select></label><div className="github-list-controls"><div className="model-tabs"><button className={tab === "issues" ? "selected" : ""} onClick={() => setTab("issues")}>Issues</button><button className={tab === "prs" ? "selected" : ""} onClick={() => setTab("prs")}>Pull requests</button></div><select value={itemState} onChange={(event) => setItemState(event.target.value as "open" | "closed" | "all")} aria-label="Item state"><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select></div>{items.length ? <div className="github-items">{items.map((item) => <article className="github-item" key={`${item.number}-${item.html_url}`}><div><span className="model-badge">#{item.number} · {item.state}</span><h3>{item.title}</h3><p>{item.head?.ref ? `${item.head.ref} → ${item.base?.ref ?? "default"}` : item.body?.slice(0, 180) || "No description provided."}</p></div><button className="row-action" onClick={() => void onAction("github:open", { url: item.html_url })}>Open ↗</button></article>)}</div> : <div className="download-empty">{repository ? `No ${itemState} ${tab} were returned for ${repository}.` : "Search repositories, then choose one to browse its issues and pull requests."}</div>}</section></div>;
}

function RemoteFallbackSettings({ endpoint, model, endpointSource, modelSource, onApply }: { endpoint: string; model: string; endpointSource?: string; modelSource?: string; onApply: (endpoint: string, model: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState({ endpoint, model });
  useEffect(() => setDraft({ endpoint, model }), [endpoint, model]);
  return <><div className="inference-grid"><label>Remote LM Studio HTTPS/HTTP base URL<input aria-label="Remote fallback endpoint" type="url" placeholder="https://inference.example.com" value={draft.endpoint} onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}/><small>Effective source · {endpointSource ?? "not configured"}</small></label><label>Remote model key<input aria-label="Remote fallback model key" value={draft.model} placeholder="publisher/model" onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}/><small>Effective source · {modelSource ?? "not configured"}</small></label></div><button className="secondary-button full-button" onClick={() => void onApply(draft.endpoint, draft.model)}>Save remote fallback target</button></>;
}

function ScopedSettings({ busy, onInspect, onSave, onReset }: { busy: boolean; onInspect: (key: string, scope: DesktopSettingScope, scopeId: string, contextMissionId: string) => Promise<any>; onSave: (key: string, scope: DesktopSettingScope, scopeId: string, value: unknown) => Promise<any>; onReset: (key: string, scope: DesktopSettingScope, scopeId: string) => Promise<any> }) {
  const [key, setKey] = useState<(typeof scopedSettingKeys)[number]>(scopedSettingKeys[0]);
  const [scope, setScope] = useState<DesktopSettingScope>("project");
  const [scopeId, setScopeId] = useState("");
  const [contextMissionId, setContextMissionId] = useState("");
  const [draft, setDraft] = useState("");
  const [effective, setEffective] = useState<Record<string, any> | null>(null);
  const [message, setMessage] = useState("");
  const validTarget = scope === "global" || Boolean(scopeId.trim());
  const inspect = async () => {
    if (!validTarget) { setMessage(`Enter the ${scope} ID to inspect its setting.`); return; }
    const result = await onInspect(key, scope, scopeId.trim(), contextMissionId.trim());
    if (result) {
      setEffective(result);
      setDraft(result.configured === false ? "" : JSON.stringify(result.value, null, 2));
      setMessage(result.configured === false ? "No value is stored for this context; the runtime default applies." : "Effective value loaded. Edit the JSON to add an override at the selected scope.");
    }
  };
  const save = async () => {
    if (!validTarget) { setMessage(`Enter the ${scope} ID before saving an override.`); return; }
    try {
      const value = JSON.parse(draft);
      const result = await onSave(key, scope, scopeId.trim(), value);
      if (result) { setMessage(`Saved ${key} at ${scope}${scope === "global" ? "" : ` · ${scopeId.trim()}`}.`); await inspect(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const reset = async () => {
    if (!validTarget) { setMessage(`Enter the ${scope} ID before clearing an override.`); return; }
    const result = await onReset(key, scope, scopeId.trim());
    if (result) { setMessage(`Cleared the ${scope} override for ${key}.`); await inspect(); }
  };
  return <section className="panel settings-panel scoped-settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">SCOPED CONFIGURATION</div><h2>Project and run overrides</h2></div></div><p className="settings-foot">Set documented runtime settings at global, project, mission, agent, or session scope. Effective precedence: session → agent → mission → project → global. Selected setting applies: {settingApplyWhen[key]}. Use the same IDs supplied in project, mission, agent, or session contexts. For agent overrides used in multiple missions, provide the parent mission when inspecting its effective value.</p><label className="model-select-label">SETTING KEY<select aria-label="Scoped setting key" value={key} onChange={(event) => { setKey(event.target.value as (typeof scopedSettingKeys)[number]); setEffective(null); setMessage(""); setDraft(""); }}>{scopedSettingKeys.map((settingKey) => <option key={settingKey} value={settingKey}>{settingKey}</option>)}</select></label><div className="inference-grid"><label>OVERRIDE SCOPE<select aria-label="Override scope" value={scope} onChange={(event) => { setScope(event.target.value as DesktopSettingScope); setScopeId(""); setContextMissionId(""); setDraft(""); setEffective(null); setMessage(""); }}><option value="global">Global</option><option value="project">Project</option><option value="mission">Mission</option><option value="agent">Agent</option><option value="session">Temporary session</option></select></label>{scope !== "global" && <label>{scope.toUpperCase()} ID<input aria-label={`${scope} ID`} maxLength={500} value={scopeId} onChange={(event) => { setScopeId(event.target.value); setDraft(""); setEffective(null); }} placeholder={`Enter the ${scope} record ID`}/></label>}{scope === "agent" && <label>PARENT MISSION CONTEXT<input aria-label="Parent mission context ID" maxLength={500} value={contextMissionId} onChange={(event) => { setContextMissionId(event.target.value); setDraft(""); setEffective(null); }} placeholder="Optional when agent belongs to one mission"/></label>}</div><div className="memory-actions"><button className="secondary-button" disabled={busy || !validTarget} onClick={() => void inspect()}>Load effective value</button><small className="setting-source">{effective?.source ? `Effective source · ${effective.source}${effective.scopeId ? ` · ${effective.scopeId}` : ""}` : "Load the value to see its effective source."}</small></div>{effective?.configured !== false && <label className="model-select-label">SETTING VALUE · JSON<textarea aria-label="Scoped setting JSON value" rows={5} spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Enter a JSON value, such as true, 4, or a string"/></label>}{effective?.configured === false && <label className="model-select-label">NEW OVERRIDE VALUE · JSON<textarea aria-label="New scoped setting JSON value" rows={5} spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Enter a JSON value, such as true, 4, or a string"/></label>}<div className="memory-actions"><button className="primary-button" disabled={busy || !draft.trim()} onClick={() => void save()}>Save override</button><button className="secondary-button" disabled={busy || !validTarget || !effective} onClick={() => void reset()}>Clear override</button></div>{message && <p className="settings-foot" role="status">{message}</p>}</section>;
}

function BrowserDownloadLimitSettings({ setting, onSave }: { setting?: { value?: number; source?: string }; onSave: (bytes: number) => Promise<unknown> }) {
  const toMiB = (bytes: number | undefined) => String((bytes ?? 512 * 1024 ** 2) / (1024 ** 2));
  const [draft, setDraft] = useState(() => toMiB(setting?.value));
  useEffect(() => setDraft(toMiB(setting?.value)), [setting?.value]);
  const bytes = Math.round(Number(draft) * 1024 ** 2);
  const valid = Number.isSafeInteger(bytes) && bytes >= 1024 ** 2 && bytes <= 10 * 1024 ** 3;
  return <div className="inference-grid"><label>MAXIMUM BROWSER DOWNLOAD (MiB)<input aria-label="Maximum browser download size in MiB" type="number" min="1" max="10240" step="any" value={draft} onChange={(event) => setDraft(event.target.value)}/><small>Set the full 1 MiB–10 GiB runtime range. Effective source · {setting?.source ?? "runtime default"}</small></label><button className="secondary-button" disabled={!valid} onClick={() => void onSave(bytes)}>Save browser download limit</button></div>;
}

function DefaultModelSettings({ setting, models, onSave }: { setting?: { value?: string; source?: string }; models: Array<Record<string, any>>; onSave: (model: string) => Promise<unknown> }) {
  const key = String(setting?.value ?? "");
  const llms = models.filter((model) => model.type === "llm");
  return <label className="model-select-label">DEFAULT MODEL<select aria-label="Default model" value={key} onChange={(event) => void onSave(event.target.value)}><option value="">Automatic selection / no fixed default</option>{key && !llms.some((model) => model.key === key) && <option value={key}>Configured · {key}</option>}{llms.map((model) => <option key={model.key} value={String(model.key)}>{model.name ?? model.key}</option>)}</select><small className="setting-source">Effective source · {setting?.source ?? "runtime default"}. Applies to the next agent or mission planning run.</small></label>;
}

function ModelDownloadLimitSettings({ setting, onSave }: { setting?: { value?: number; source?: string }; onSave: (bytes: number) => Promise<unknown> }) {
  const toMiB = (bytes: number | undefined) => String((bytes ?? 20 * 1024 ** 3) / (1024 ** 2));
  const [draft, setDraft] = useState(() => toMiB(setting?.value));
  useEffect(() => setDraft(toMiB(setting?.value)), [setting?.value]);
  const bytes = Math.round(Number(draft) * 1024 ** 2);
  const valid = Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= 20 * 1024 ** 3;
  return <div className="inference-grid"><label>MAXIMUM MODEL DOWNLOAD SIZE (MiB)<input aria-label="Maximum model download size in MiB" type="number" min="0.000001" max="20480" step="any" value={draft} onChange={(event) => setDraft(event.target.value)}/><small>Reject artifacts larger than this before download. Effective source · {setting?.source ?? "runtime default"}</small></label><button className="secondary-button" disabled={!valid} onClick={() => void onSave(bytes)}>Save model download limit</button></div>;
}
function ModelLicenseSettings({ setting, onSave }: { setting?: { value?: string[]; source?: string }; onSave: (licenses: string[]) => Promise<unknown> }) {
  const stored = JSON.stringify(setting?.value ?? []);
  const [draft, setDraft] = useState(() => (setting?.value ?? []).join("\n"));
  useEffect(() => setDraft((setting?.value ?? []).join("\n")), [stored]);
  const licenses = [...new Set(draft.split(/\r?\n|,/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const valid = licenses.length <= 100 && licenses.every((license) => /^[a-z0-9][a-z0-9.+-]{0,99}$/.test(license));
  return <div className="license-settings"><label className="model-select-label">LICENSES PERMITTED FOR AUTOMATIC MODEL DOWNLOADS<textarea aria-label="Automatic model download license preferences" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="mit&#10;apache-2.0"/><small>One lowercase Hugging Face license tag per line. Empty blocks automatic acquisition. Review each license and model card. Effective source · {setting?.source ?? "runtime default"}</small></label><button className="secondary-button" disabled={!valid} onClick={() => void onSave(licenses)}>Save license preferences</button></div>;
}
function ToggleRow({ title, description, value, source, onChange }: { title: string; description: string; value: boolean; source?: string; onChange: (value: boolean) => void }) {
  return <div className="toggle-row"><div><strong>{title}</strong><p>{description}</p><small className="setting-source">Effective source · {source ?? "This device"}</small></div><button className={`toggle ${value ? "on" : ""}`} role="switch" aria-label={title} aria-checked={value} onClick={() => onChange(!value)}><span/></button></div>;
}

type AccessDraft = { mode: "full" | "restricted"; readRoots: string; writeRoots: string; allowedExecutables: string; network: boolean; integrations: boolean; backgroundJobs: boolean; externalActions: boolean };
function AccessProfileSettings({ setting, onApply }: { setting: { value: Record<string, any>; source: string }; onApply: (profile: Record<string, unknown>) => Promise<void> }) {
  const toDraft = (profile: Record<string, any>): AccessDraft => ({ mode: profile.mode === "restricted" ? "restricted" : "full", readRoots: Array.isArray(profile.readRoots) ? profile.readRoots.join("\n") : "", writeRoots: Array.isArray(profile.writeRoots) ? profile.writeRoots.join("\n") : "", allowedExecutables: Array.isArray(profile.allowedExecutables) ? profile.allowedExecutables.join("\n") : "", network: profile.network === true, integrations: profile.integrations === true, backgroundJobs: profile.backgroundJobs === true, externalActions: profile.externalActions === true });
  const storedProfile = JSON.stringify(setting.value ?? { mode: "full", network: true, integrations: true, backgroundJobs: true, externalActions: true });
  const [draft, setDraft] = useState<AccessDraft>(() => toDraft(JSON.parse(storedProfile)));
  useEffect(() => setDraft(toDraft(JSON.parse(storedProfile))), [storedProfile]);
  const update = (key: keyof AccessDraft, value: string | boolean) => setDraft((current) => ({ ...current, [key]: value }));
  const changeMode = (mode: AccessDraft["mode"]) => setDraft((current) => mode === "restricted" ? { ...current, mode, network: false, integrations: false, backgroundJobs: false, externalActions: false } : { ...current, mode, network: true, integrations: true, backgroundJobs: true, externalActions: true });
  const lines = (value: string) => value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const save = () => onApply({ mode: draft.mode, ...(draft.mode === "restricted" ? { readRoots: lines(draft.readRoots), writeRoots: lines(draft.writeRoots), allowedExecutables: lines(draft.allowedExecutables), network: draft.network, integrations: draft.integrations, backgroundJobs: draft.backgroundJobs, externalActions: draft.externalActions } : { network: true, integrations: true, backgroundJobs: true, externalActions: true }) });
  return <section className="panel settings-panel"><div className="panel-title"><div><div className="eyebrow small-eyebrow">ACTIVE ACCESS PROFILE</div><h2>Filesystem and capabilities</h2></div></div><p className="settings-foot">Effective source · {setting.source}. Changes apply to the next CLI or agent operation. Full access means the current account’s existing permissions; it does not elevate the process.</p><label className="model-select-label">ACCESS MODE<select aria-label="Access profile mode" value={draft.mode} onChange={(event) => changeMode(event.target.value as AccessDraft["mode"])}><option value="full">Full access</option><option value="restricted">Restricted allowlists</option></select></label>{draft.mode === "restricted" ? <><div className="profile-path-grid"><label>Read roots, one path per line<textarea aria-label="Restricted read roots" rows={3} value={draft.readRoots} onChange={(event) => update("readRoots", event.target.value)}/></label><label>Write roots, one path per line<textarea aria-label="Restricted write roots" rows={3} value={draft.writeRoots} onChange={(event) => update("writeRoots", event.target.value)}/></label><label>Allowed executables, one name per line<textarea aria-label="Restricted allowed executables" rows={3} value={draft.allowedExecutables} onChange={(event) => update("allowedExecutables", event.target.value)}/></label></div><ToggleRow title="Network access" description="Allow outbound network features supported by Xyst." value={draft.network} source={setting.source} onChange={(value) => update("network", value)}/><ToggleRow title="Authenticated integrations" description="Allow configured GitHub and MCP integrations, subject to their own settings." value={draft.integrations} source={setting.source} onChange={(value) => update("integrations", value)}/><ToggleRow title="Background jobs" description="Allow mission and process background jobs." value={draft.backgroundJobs} source={setting.source} onChange={(value) => update("backgroundJobs", value)}/><ToggleRow title="External actions" description="Allow writes to external services and interactive browser actions." value={draft.externalActions} source={setting.source} onChange={(value) => update("externalActions", value)}/></> : <p className="settings-foot">The active profile allows files and programs accessible to this account, network access, configured integrations, background jobs, and authorized external actions.</p>}<button className="secondary-button full-button" onClick={() => void save()}>Apply access profile</button></section>;
}

function AgentControls({ agent, missions, onAction, busy }: { agent: Record<string, any>; missions: Array<Record<string, any>>; onAction: (action: string, payload: unknown) => Promise<any>; busy: boolean }) {
  const definition = agent.definition ?? {};
  const mission = missions.find((entry) => entry.id === agent.mission_id);
  const taskId = String(definition.taskId ?? "");
  const task = mission?.definition?.tasks?.find((entry: Record<string, any>) => entry.id === taskId);
  const role = definition.profile ?? {};
  const currentRole = mission?.definition?.agents?.find((entry: Record<string, any>) => entry.id === task?.agentId) ?? role;
  const [model, setModel] = useState(String(task?.model ?? ""));
  const [turns, setTurns] = useState(task?.maxTurns === undefined ? "" : String(task.maxTurns));
  const [saved, setSaved] = useState("");
  useEffect(() => {
    setModel(String(task?.model ?? ""));
    setTurns(task?.maxTurns === undefined ? "" : String(task.maxTurns));
    setSaved("");
  }, [task?.model, task?.maxTurns, mission?.updated_at]);
  if (!mission || !task || !taskId) return <p className="agent-control-note">This record has no editable mission task.</p>;
  const locked = busy || mission.status === "running" || mission.status === "archived";
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await onAction("mission:task-configure", { id: mission.id, taskId, model: model.trim() || null, maxTurns: turns === "" ? null : Number(turns) });
    if (result && !result.error) setSaved("Saved for future executions.");
  };
  const effectiveModel = task.model ?? currentRole.model ?? mission.definition?.model ?? "automatic";
  const effectiveTurns = task.maxTurns ?? currentRole.maxTurns ?? "default";
  const taskAction = agent.status === "running" ? "pause" : agent.status === "paused" ? "resume" : agent.status === "failed" ? "retry" : undefined;
  const taskActionDisabled = busy || (taskAction === "pause" && mission.status !== "running") || (taskAction === "retry" && mission.status === "running");
  return <form className="agent-controls" onSubmit={save}>
    <div className="agent-control-heading"><strong>Execution controls</strong><small>Effective · {effectiveModel} · {effectiveTurns} turns</small></div>
    <div className="agent-control-fields">
      <label>MODEL OVERRIDE<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Inherit mission model" aria-label={`Model override for ${taskId}`} maxLength={200}/></label>
      <label>TURN LIMIT<input type="number" min={1} max={50} value={turns} onChange={(event) => setTurns(event.target.value)} placeholder="Inherit" aria-label={`Turn limit for ${taskId}`}/></label>
      <button className="row-action" disabled={locked || (turns !== "" && (!Number.isInteger(Number(turns)) || Number(turns) < 1 || Number(turns) > 50))}>Save</button>
    </div>
    <small className="agent-control-note">Blank values inherit the mission or agent profile. Changes apply to future executions; active missions and archived missions are locked.</small>
    {saved && <small className="agent-control-saved" role="status">{saved}</small>}
    {taskAction && <div className="agent-task-actions"><button type="button" className={taskAction === "retry" ? "secondary-button" : "row-action"} disabled={taskActionDisabled || mission.status === "archived"} onClick={() => void onAction(`mission:task-${taskAction}`, { id: mission.id, taskId })}>{taskAction === "pause" ? "Pause this agent" : taskAction === "resume" ? "Resume this agent" : "Retry this agent"}</button><small>Task action · {agent.status}</small></div>}
  </form>;
}

function statusClass(status: string) { return ["running", "active", "completed"].includes(status) ? "status-good" : status === "paused" || status === "interrupted" ? "status-warn" : status === "failed" || status === "cancelled" ? "status-bad" : ""; }
function formatBytes(value?: number) { if (!value) return "Size unknown"; const units = ["B", "KB", "MB", "GB", "TB"]; let size = value; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`; }
function deriveQuantizations(files: Array<{ name?: string }>) { return [...new Set(files.map((file) => file.name?.match(/(iq\d+_[a-z0-9_]+|q\d+_[a-z0-9_]+)/i)?.[0]?.toUpperCase()).filter((value): value is string => Boolean(value)))].sort(); }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
