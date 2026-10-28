import type { LMStudioModel } from "@xyst/runtime";

export function desktopModelSnapshot(model: LMStudioModel) {
  return {
    key: model.key,
    name: model.display_name,
    type: model.type,
    sizeBytes: model.size_bytes,
    quantization: model.quantization?.name,
    maxContext: model.max_context_length,
    capabilities: model.capabilities,
    loaded_instances: model.loaded_instances
  };
}
