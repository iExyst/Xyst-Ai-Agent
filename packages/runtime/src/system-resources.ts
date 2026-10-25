import { freemem, totalmem } from "node:os";
import type { AccessController } from "./access.js";
import { runProcess, type ProcessResult } from "./platform.js";

export interface GpuMemoryDevice {
  name: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface HostResourceStats {
  source: "Xyst host";
  checkedAt: string;
  systemMemory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
  nvidiaGpuMemory: { status: "available" | "unavailable" | "blocked"; source: "nvidia-smi"; devices: GpuMemoryDevice[]; reason?: string };
}

function parseNvidiaSmiCsv(text: string): GpuMemoryDevice[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 4) throw new Error("nvidia-smi returned an unexpected CSV row");
    const values = fields.slice(-3).map(Number);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("nvidia-smi returned invalid memory values");
    const [totalMiB, usedMiB, freeMiB] = values as [number, number, number];
    return { name: fields.slice(0, -3).join(", "), totalBytes: totalMiB * 1024 ** 2, usedBytes: usedMiB * 1024 ** 2, freeBytes: freeMiB * 1024 ** 2 };
  });
}

export function parseLmStudioResourceEstimate(text: string): { gpuBytes?: number; totalBytes?: number } {
  const bytes = (label: string): number | undefined => {
    const match = text.match(new RegExp(`^\\s*Estimated ${label}:\\s*([\\d,]+(?:\\.\\d+)?)\\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\\s*$`, "im"));
    if (!match) return undefined;
    const value = Number(match[1]!.replaceAll(",", ""));
    const unit = match[2]!.toLowerCase();
    const power = unit.startsWith("ki") || unit.startsWith("mi") || unit.startsWith("gi") || unit.startsWith("ti") ? 1024 : 1000;
    const exponent = unit.startsWith("t") ? 4 : unit.startsWith("g") ? 3 : unit.startsWith("m") ? 2 : unit.startsWith("k") ? 1 : 0;
    const result = value * power ** exponent;
    return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? Math.ceil(result) : undefined;
  };
  const gpuBytes = bytes("GPU Memory");
  const totalBytes = bytes("Total Memory");
  return { ...(gpuBytes === undefined ? {} : { gpuBytes }), ...(totalBytes === undefined ? {} : { totalBytes }) };
}

export async function readHostResourceStats(
  access: AccessController,
  commandRunner: (command: string, args: string[], options?: { timeoutMs?: number; maxOutputChars?: number }) => Promise<ProcessResult> = runProcess
): Promise<HostResourceStats> {
  const total = totalmem();
  const available = freemem();
  const checkedAt = new Date().toISOString();
  const systemMemory = { totalBytes: total, usedBytes: Math.max(0, total - available), availableBytes: available, usedPercent: total > 0 ? Math.round((total - available) / total * 1000) / 10 : 0 };
  const base = { source: "Xyst host" as const, checkedAt, systemMemory };
  const command = process.env.NVIDIA_SMI_PATH ?? (process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi");
  try {
    access.assertExecutable(command);
  } catch (error) {
    return { ...base, nvidiaGpuMemory: { status: "blocked", source: "nvidia-smi", devices: [], reason: error instanceof Error ? error.message : String(error) } };
  }
  try {
    const result = await commandRunner(command, ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"], { timeoutMs: 5000, maxOutputChars: 4000 });
    if (result.code !== 0) return { ...base, nvidiaGpuMemory: { status: "unavailable", source: "nvidia-smi", devices: [], reason: (result.stderr || result.stdout || "nvidia-smi is unavailable").slice(0, 300) } };
    const devices = parseNvidiaSmiCsv(result.stdout);
    return devices.length
      ? { ...base, nvidiaGpuMemory: { status: "available", source: "nvidia-smi", devices } }
      : { ...base, nvidiaGpuMemory: { status: "unavailable", source: "nvidia-smi", devices: [], reason: "No NVIDIA GPU memory data was returned" } };
  } catch (error) {
    return { ...base, nvidiaGpuMemory: { status: "unavailable", source: "nvidia-smi", devices: [], reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) } };
  }
}
