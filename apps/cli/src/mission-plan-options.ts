export interface MissionPlanArguments {
  objective: string;
  name?: string;
  workspace?: string;
  projectId?: string;
  model?: string;
  maxConcurrency?: number;
}

export const MISSION_PLAN_USAGE = "Usage: mission plan <objective> [--name NAME] [--workspace PATH] [--project ID] [--model KEY] [--max-concurrency 1-8]";

export function parseMissionPlanArguments(args: string[]): MissionPlanArguments {
  let name: string | undefined; let workspace: string | undefined; let projectId: string | undefined; let model: string | undefined; let maxConcurrency: number | undefined;
  const objectiveParts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (["--name", "--workspace", "--project", "--model", "--max-concurrency"].includes(token)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      if (token === "--name") name = value;
      else if (token === "--workspace") workspace = value;
      else if (token === "--project") projectId = value;
      else if (token === "--model") model = value;
      else maxConcurrency = Number(value);
    } else objectiveParts.push(token);
  }
  const objective = objectiveParts.join(" ").trim();
  if (!objective) throw new Error(MISSION_PLAN_USAGE);
  return { objective, ...(name ? { name } : {}), ...(workspace ? { workspace } : {}), ...(projectId ? { projectId } : {}), ...(model ? { model } : {}), ...(maxConcurrency !== undefined ? { maxConcurrency } : {}) };
}
