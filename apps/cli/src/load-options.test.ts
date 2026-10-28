import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, PersistentMissionRunner } from "@xyst/runtime";
import { parseLoadOptions } from "./load-options.js";
import { installMissionService, missionServiceStatus, renderSystemdMissionUnit, renderWindowsMissionTaskScript, systemdMissionUnitPath, uninstallMissionService } from "./mission-service.js";
import { getMissionTemplate, MISSION_TEMPLATES } from "./mission-templates.js";
import { createAgentUserMessage } from "./attachments.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { ProcessResult } from "@xyst/runtime";

const execFile = promisify(execFileCallback);

test("agent attachments preserve text and create LM Studio vision data URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xyst-attachment-test-"));
  try {
    const textPath = join(directory, "notes.md");
    const imagePath = join(directory, "pixel.png");
    const pdfPath = join(directory, "report.pdf");
    await writeFile(textPath, "Line one\r\nLine two", "utf8");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4sAAAAASUVORK5CYII=", "base64"));
    const pdf = await PDFDocument.create(); const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica); page.drawText("Visible PDF words", { x: 30, y: 700, font }); await writeFile(pdfPath, await pdf.save());
    const message = await createAgentUserMessage("Summarize these attachments", [textPath, imagePath, pdfPath]);
    assert.equal(message.role, "user");
    assert.ok(Array.isArray(message.content));
    assert.match(String(message.content[1]?.text), /Attached text file: notes\.md/);
    assert.match(String(message.content[1]?.text), /Line one\r?\nLine two/);
    assert.equal(message.content[2]?.type, "text");
    assert.equal(message.content[3]?.type, "image_url");
    assert.match(String((message.content[3]?.image_url as { url: string }).url), /^data:image\/png;base64,/);
    assert.match(String(message.content[4]?.text), /Attached PDF: report\.pdf; 1 pages/);
    assert.match(String(message.content[4]?.text), /Visible PDF words/);
    assert.deepEqual(await createAgentUserMessage("Just text", []), { role: "user", content: "Just text" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("agent attachments reject unsupported, oversized, and excessive input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xyst-bad-attachment-test-"));
  try {
    const binaryPath = join(directory, "archive.bin");
    const badImagePath = join(directory, "photo.jpg");
    const badPdfPath = join(directory, "not-a-pdf.pdf");
    const scannedPdfPath = join(directory, "scanned.pdf");
    const hugePath = join(directory, "large.txt");
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));
    await writeFile(badImagePath, "not an image");
    await writeFile(badPdfPath, "not a PDF");
    const scannedPdf = await PDFDocument.create(); scannedPdf.addPage(); await writeFile(scannedPdfPath, await scannedPdf.save());
    await writeFile(hugePath, Buffer.alloc(1024 * 1024 + 1, 97));
    await assert.rejects(() => createAgentUserMessage("Inspect", [binaryPath]), /binary/);
    await assert.rejects(() => createAgentUserMessage("Inspect", [badImagePath]), /supported .* signature/);
    await assert.rejects(() => createAgentUserMessage("Inspect", [badPdfPath]), /PDF signature/);
    await assert.rejects(() => createAgentUserMessage("Inspect", [scannedPdfPath]), /no extractable text, including offline OCR/);
    await assert.rejects(() => createAgentUserMessage("Inspect", [hugePath]), /exceeds the 1 MiB/);
    await assert.rejects(() => createAgentUserMessage("Inspect", Array(11).fill(binaryPath)), /At most 10/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("mission templates provide valid task graphs and execute through the normal runner", async () => {
  const ids = new Set<string>();
  const dataDir = await mkdtemp(join(tmpdir(), "xyst-template-test-"));
  const runtime = createRuntime({ dataDir });
  try {
  const repositoryPath = join(dataDir, "repository");
  await mkdir(repositoryPath);
  await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFile("git", ["config", "user.name", "Xyst Template Test"], { cwd: repositoryPath });
  await execFile("git", ["config", "user.email", "xyst-template-test@example.invalid"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "Mission template runtime fixture\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFile("git", ["commit", "-m", "Initialize mission template fixture"], { cwd: repositoryPath });

  for (const template of MISSION_TEMPLATES) {
    assert.equal(ids.has(template.id), false);
    ids.add(template.id);
    const definition = getMissionTemplate(template.id) as { name: string; objective: string; workspace?: string; tasks: Array<{ id: string; dependsOn: string[] }> };
    assert.ok(definition.name.length > 0);
    assert.ok(definition.objective.length > 0);
    assert.ok(definition.tasks.length > 0);
    const taskIds = new Set(definition.tasks.map((task) => task.id));
    assert.equal(taskIds.size, definition.tasks.length);
    for (const task of definition.tasks) for (const dependency of task.dependsOn) assert.ok(taskIds.has(dependency), `${template.id} has unknown dependency ${dependency}`);
    assert.equal(runtime.missions.repository.create(definition).definition.name, definition.name);
  }
  assert.equal((getMissionTemplate("issue-to-pr") as any).github.writeEnabled, false);
  assert.equal((getMissionTemplate("pr-review") as any).github.writeEnabled, false);
  const documentTasks = (getMissionTemplate("document-spreadsheet") as { tasks: Array<{ id: string; objective: string; expectedOutputs: string[]; allowedTools?: string[] }> }).tasks;
  const documentPlanTask = documentTasks.find((task) => task.id === "plan-artifact");
  const documentCreateObjective = documentTasks.find((task) => task.id === "create-artifact")?.objective ?? "";
  const documentVerifyObjective = documentTasks.find((task) => task.id === "verify-artifact")?.objective ?? "";
  assert.deepEqual(documentPlanTask?.expectedOutputs, ["artifact-plan.md"]);
  assert.match(documentPlanTask?.objective ?? "", /reopen that exact file with file_read/);
  assert.match(documentCreateObjective, /Do not repeat the title text anywhere in the body/);
  assert.match(documentVerifyObjective, /inspect the returned image pixels/);
  assert.match(documentVerifyObjective, /read-only verification task/);
  assert.match(documentVerifyObjective, /report it instead of changing the file/);
  assert.match(documentVerifyObjective, /PNG path alone is not visual evidence/);
  assert.match(documentVerifyObjective, /any repeated or missing content/);
  assert.match(documentVerifyObjective, /do not claim visual verification/);
  assert.deepEqual(documentTasks.find((task) => task.id === "plan-artifact")?.allowedTools, ["file_create", "file_read"]);
  assert.deepEqual(documentTasks.find((task) => task.id === "create-artifact")?.allowedTools, ["file_read", "office_create", "office_read"]);
  assert.deepEqual(documentTasks.find((task) => task.id === "verify-artifact")?.allowedTools, ["office_read", "office_preview"]);
  assert.throws(() => getMissionTemplate("unknown-template"), /Unknown mission template/);

  const runCalls: Array<{ objective: string; options: Record<string, unknown> }> = [];
  let sessionNumber = 0;
  const runner = new PersistentMissionRunner({
    store: runtime.store,
    config: runtime.config,
    events: runtime.events,
    agent: {
      run: async (objective: string, options: Record<string, unknown> & { onSession?: (id: string) => void }) => {
        runCalls.push({ objective, options });
        const sessionId = `template-session-${++sessionNumber}`;
        options.onSession?.(sessionId);
        return { sessionId, model: "fixture", turns: 1, status: "completed" as const, response: `verified-step-${sessionNumber}` };
      }
    } as never
  });
  for (const template of MISSION_TEMPLATES) {
    const startCall = runCalls.length;
    const startSession = sessionNumber;
    const definition = getMissionTemplate(template.id) as { name: string; objective: string; workspace?: string; tasks: Array<{ id: string; dependsOn: string[]; allowedTools?: string[] }> };
    definition.objective = `Execute the ${template.id} template through the standard mission runner.`;
    definition.workspace = repositoryPath;
    const executableMission = runner.repository.create(definition);
    const run = await runner.run(executableMission.id);
    assert.equal(run.status, "completed", `${template.id} should complete through PersistentMissionRunner`);
    assert.equal(runCalls.length - startCall, definition.tasks.length, `${template.id} should execute each task once`);
    assert.match(runCalls[startCall]!.objective, new RegExp(`Execute the ${template.id} template`));
    for (const task of definition.tasks.filter((item) => item.allowedTools)) {
      const taskCall = runCalls.slice(startCall, startCall + definition.tasks.length).find((call) => call.options.agentId === task.id);
      assert.deepEqual(taskCall?.options.allowedTools, task.allowedTools, `${template.id}/${task.id} should pass its tool allowlist to AgentRunner`);
    }
    for (let index = 1; index < definition.tasks.length; index++) assert.match(runCalls[startCall + index]!.objective, new RegExp(`verified-step-${startSession + index}`), `${template.id} should pass the preceding task result to its dependent`);
    const runTasks = runtime.store.db.prepare("SELECT task_key,state,attempts FROM mission_tasks WHERE run_id=? ORDER BY task_key").all(run.runId) as Array<{ task_key: string; state: string; attempts: number }>;
    assert.deepEqual(runTasks, definition.tasks.map((task) => ({ task_key: task.id, state: "completed", attempts: 1 })).sort((left, right) => left.task_key.localeCompare(right.task_key)), `${template.id} persisted task states`);
    for (const workspace of runner.listWorkspaces(executableMission.id) as Array<{ task_key: string; mode: string }>) {
      if (workspace.mode === "worktree") await runner.removeWorktree(executableMission.id, run.runId, workspace.task_key);
    }
  }
  } finally { runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("LM Studio load options validate and map documented settings", () => {
  assert.deepEqual(parseLoadOptions(["--context-length", "8192", "--eval-batch-size", "512", "--flash-attention", "--num-experts", "4", "--offload-kv-cache-to-gpu"]), {
    echo_load_config: true, context_length: 8192, eval_batch_size: 512, flash_attention: true, num_experts: 4, offload_kv_cache_to_gpu: true
  });
  assert.deepEqual(parseLoadOptions(["--no-flash-attention", "--no-offload-kv-cache-to-gpu"]), {
    echo_load_config: true, flash_attention: false, offload_kv_cache_to_gpu: false
  });
  assert.deepEqual(parseLoadOptions(["4096"]), { echo_load_config: true, context_length: 4096 });
  assert.deepEqual(parseLoadOptions(["--gpu", "0.5"]), { echo_load_config: true, gpu_offload: 0.5 });
  assert.deepEqual(parseLoadOptions(["--gpu", "auto"]), { echo_load_config: true, gpu_offload: "auto" });
  assert.deepEqual(parseLoadOptions(["--ttl", "900"]), { echo_load_config: true, ttl_seconds: 900 });
  assert.deepEqual(parseLoadOptions(["--speculative-draft-model", "publisher/draft", "--speculative-draft-max-tokens", "8", "--speculative-draft-min-tokens", "2", "--speculative-draft-min-continue-probability", "0.4"]), {
    echo_load_config: true, draft_model: "publisher/draft", speculative_draft_max_tokens: 8, speculative_draft_min_tokens: 2, speculative_draft_min_continue_probability: 0.4
  });
  assert.deepEqual(parseLoadOptions(["--speculative-draft-mtp"]), { echo_load_config: true, speculative_draft_mtp: true });
});

test("LM Studio load options reject invalid values and unknown flags", () => {
  assert.throws(() => parseLoadOptions(["--context-length", "0"]), /positive integer/);
  assert.throws(() => parseLoadOptions(["--eval-batch-size"]), /requires a positive integer/);
  assert.throws(() => parseLoadOptions(["--gpu", "1.5"]), /ratio from 0 to 1/);
  assert.throws(() => parseLoadOptions(["--ttl", "0"]), /positive integer/);
  assert.throws(() => parseLoadOptions(["--speculative-draft-model", "publisher/draft", "--speculative-draft-mtp"]), /Choose either/);
  assert.throws(() => parseLoadOptions(["--speculative-draft-max-tokens", "8"]), /before setting draft limits/);
  assert.throws(() => parseLoadOptions(["--mystery"]), /Unknown LM Studio load option/);
});

test("mission service definitions preserve executable paths and restart policy", () => {
  const spec = { executable: "C:\\Program Files\\Xyst\\node.exe", cliEntry: "C:\\Program Files\\Xyst\\cli.js", workingDirectory: "C:\\Users\\Operator\\Project" };
  const daemonArguments = ["--webhook", "--webhook-host", "127.0.0.1", "--webhook-port", "8787", "--webhook-path", "/github/webhook"];
  const unit = renderSystemdMissionUnit({ ...spec, executable: "/opt/Xyst Runtime/node", cliEntry: "/opt/Xyst App/cli.js", workingDirectory: "/home/operator/Xyst Project", daemonArguments });
  assert.match(unit, /ExecStart="\/opt\/Xyst Runtime\/node" "\/opt\/Xyst App\/cli\.js" "mission" "daemon" "--webhook" "--webhook-host" "127\.0\.0\.1" "--webhook-port" "8787" "--webhook-path" "\/github\/webhook"/);
  assert.match(unit, /WorkingDirectory=~/);
  assert.match(unit, /Environment="XYST_ROOT=\/home\/operator\/Xyst Project"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /TimeoutStopSec=infinity/);
  const windows = renderWindowsMissionTaskScript({ ...spec, daemonArguments }, "install");
  assert.match(windows, /-AtLogOn/);
  assert.match(windows, /-MultipleInstances IgnoreNew/);
  assert.match(windows, /Register-ScheduledTask/);
  assert.match(windows, /--webhook-host/);
  assert.match(windows, /--webhook-path/);
  assert.match(renderWindowsMissionTaskScript(spec, "uninstall"), /Unregister-ScheduledTask/);
});

test("Linux mission service install, status, and removal manage only the requested user unit", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "xyst-service-test-"));
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  const commands: string[] = [];
  const run = async (command: string, args: string[]): Promise<ProcessResult> => {
    commands.push(`${command} ${args.join(" ")}`);
    return { code: 0, signal: null, stdout: args.includes("show") ? "LoadState=loaded\nActiveState=active\nSubState=running\n" : "", stderr: "", durationMs: 1 };
  };
  try {
    const spec = { executable: "/usr/bin/node", cliEntry: "/opt/xyst/cli.js", workingDirectory: "/home/operator/project", daemonArguments: ["--webhook", "--webhook-host", "127.0.0.1", "--webhook-port", "8787", "--webhook-path", "/github/webhook"] };
    const installed = await installMissionService("linux", spec, run, env);
    const path = systemdMissionUnitPath(env);
    assert.equal(installed.installed, true);
    assert.match(await readFile(path, "utf8"), /ExecStart=.*"mission" "daemon" "--webhook".*"--webhook-port" "8787"/);
    const status = await missionServiceStatus("linux", run, env);
    assert.deepEqual([status.installed, status.activeState, status.subState], [true, "active", "running"]);
    const removed = await uninstallMissionService("linux", run, env);
    assert.equal(removed.installed, false);
    await assert.rejects(() => readFile(path), { code: "ENOENT" });
    assert.deepEqual(commands.slice(0, 3), ["systemctl --user daemon-reload", "systemctl --user enable --now xyst-mission-daemon", "systemctl --user show xyst-mission-daemon --property=LoadState --property=ActiveState --property=SubState"]);
  } finally { await rm(configHome, { recursive: true, force: true }); }
});
