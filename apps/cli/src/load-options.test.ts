import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@xyst/runtime";
import { parseLoadOptions } from "./load-options.js";
import { installMissionService, missionServiceStatus, renderSystemdMissionUnit, renderWindowsMissionTaskScript, systemdMissionUnitPath, uninstallMissionService } from "./mission-service.js";
import { getMissionTemplate, MISSION_TEMPLATES } from "./mission-templates.js";
import { createAgentUserMessage } from "./attachments.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { ProcessResult } from "@xyst/runtime";

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

test("mission templates provide schema-valid task graphs with safe GitHub defaults", async () => {
  const ids = new Set<string>();
  const dataDir = await mkdtemp(join(tmpdir(), "xyst-template-test-"));
  const runtime = createRuntime({ dataDir });
  try {
  for (const template of MISSION_TEMPLATES) {
    assert.equal(ids.has(template.id), false);
    ids.add(template.id);
    const definition = getMissionTemplate(template.id) as { name: string; objective: string; tasks: Array<{ id: string; dependsOn: string[] }> };
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
  assert.throws(() => getMissionTemplate("unknown-template"), /Unknown mission template/);
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
  const unit = renderSystemdMissionUnit({ ...spec, executable: "/opt/Xyst Runtime/node", cliEntry: "/opt/Xyst App/cli.js", workingDirectory: "/home/operator/Xyst Project", dataHome: "/home/operator/Xyst Data", daemonArguments });
  assert.match(unit, /ExecStart="\/opt\/Xyst Runtime\/node" "\/opt\/Xyst App\/cli\.js" "mission" "daemon" "--webhook" "--webhook-host" "127\.0\.0\.1" "--webhook-port" "8787" "--webhook-path" "\/github\/webhook"/);
  assert.match(unit, /WorkingDirectory=~/);
  assert.match(unit, /Environment="XYST_ROOT=\/home\/operator\/Xyst Project"/);
  assert.match(unit, /Environment="XDG_DATA_HOME=\/home\/operator\/Xyst Data"/);
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
    const spec = { executable: "/usr/bin/node", cliEntry: "/opt/xyst/cli.js", workingDirectory: "/home/operator/project", dataHome: "/home/operator/.local/share", daemonArguments: ["--webhook", "--webhook-host", "127.0.0.1", "--webhook-port", "8787", "--webhook-path", "/github/webhook"] };
    const installed = await installMissionService("linux", spec, run, env);
    const path = systemdMissionUnitPath(env);
    assert.equal(installed.installed, true);
    assert.match(await readFile(path, "utf8"), /ExecStart=.*"mission" "daemon" "--webhook".*"--webhook-port" "8787"/);
    assert.match(await readFile(path, "utf8"), /Environment="XDG_DATA_HOME=\/home\/operator\/\.local\/share"/);
    const status = await missionServiceStatus("linux", run, env);
    assert.deepEqual([status.installed, status.activeState, status.subState], [true, "active", "running"]);
    const removed = await uninstallMissionService("linux", run, env);
    assert.equal(removed.installed, false);
    await assert.rejects(() => readFile(path), { code: "ENOENT" });
    assert.deepEqual(commands.slice(0, 3), ["systemctl --user daemon-reload", "systemctl --user enable --now xyst-mission-daemon", "systemctl --user show xyst-mission-daemon --property=LoadState --property=ActiveState --property=SubState"]);
  } finally { await rm(configHome, { recursive: true, force: true }); }
});
