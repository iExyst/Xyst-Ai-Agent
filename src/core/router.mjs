import { modelPricingDataStatus } from './model-pricing.mjs';
import { modelCapabilitiesDataStatus } from './model-metadata.mjs';

export function estimateTokens(messages, { imageAttachments = [] } = {}) {
  const text = JSON.stringify(messages, (_key, value) =>
    isInlineImageDataUrl(value) ? '[image data omitted from token estimate]' : value,
  );
  const imageTokens = Array.isArray(messages)
    ? messages.reduce(
        (total, message) =>
          total +
          (Array.isArray(message?.image_attachments)
            ? message.image_attachments.reduce((sum, image) => sum + estimateImageTokens(image), 0)
            : 0),
        0,
      )
    : 0;
  const inlineImageTokens =
    Array.isArray(messages) && imageAttachments.length === 0
      ? messages.reduce((total, message) => {
          if (Array.isArray(message?.image_attachments) && message.image_attachments.length > 0) return total;
          const content = Array.isArray(message?.content) ? message.content : [];
          return total + content.reduce((sum, part) => sum + (isInlineImageDataUrl(part?.image_url?.url) ? 768 : 0), 0);
        }, 0)
      : 0;
  const extraImageTokens = Array.isArray(imageAttachments)
    ? imageAttachments.reduce((total, image) => total + estimateImageTokens(image), 0)
    : 0;
  return Math.ceil(text.length / 4 + imageTokens + inlineImageTokens + extraImageTokens);
}

function isInlineImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function estimateImageTokens(image) {
  return Math.max(768, Math.ceil((image.width || 512) / 512) * Math.ceil((image.height || 512) / 512) * 256);
}

const QUALITY_TASK_SIGNALS = [
  {
    pattern:
      /\b(?:implement|build|create|write|make|code|program|architect|design|debug|diagnos\w*|troubleshoot\w*|problem|issue|broken|not working|does not work|doesn't work|refactor|migrat\w*|integrat\w*|rewrite|patch|fix|audit|investigat\w*|analy[sz]\w*|evaluat\w*|optimi[sz]\w*|deploy|automate)\b/i,
    weight: 1,
  },
  {
    pattern:
      /\b(?:test(?:s|ing)?|security|production|architecture|cross-platform|end-to-end|multiple files|whole codebase|program(?:ming)?|coding|software|project|repository|feature)\b/i,
    weight: 1,
  },
  { pattern: /\b(?:and then|across (?:the|all|multiple)|from scratch|in its entirety|comprehensive|thorough)\b/i, weight: 1 },
];
const SPEED_TASK_SIGNALS = [
  { pattern: /\b(?:quick(?:ly)?|brief(?:ly)?|short answer|one sentence|tl;dr|just tell me|simple question)\b/i, weight: 2 },
  { pattern: /\b(?:define|definition|what does .{1,80} mean|meaning of|convert .{1,80} to|calculate)\b/i, weight: 1 },
];
const TOOL_ACTION_PATTERN =
  /\b(?:implement|build|create|write|edit|modify|change|add|update|refactor|debug|diagnos\w*|fix|patch|test|run|install|deploy|automate|make|do|work(?:ing|ed|s)?)\b/i;
const TOOL_SUBJECT_PATTERN =
  /\b(?:code|coding|program(?:ming)?|script|app|application|project|repository|repo|file|function|feature|test|tool|agent|website|ui|service|library|package|module|api|bug|issue|problem|weather|forecast|temperature|rain|snow)\b/i;
export const LIVE_LOOKUP_INTENT =
  /\b(?:look(?:ing)?\s+(?:(?:this|that|it|something|stuf+|things?)\s+)?up|find(?:ing)?\s+(?:out\s+)?(?:about|information|info|the\s+latest|the\s+current)|search(?:ing)?\s+(?:the\s+)?(?:web|internet|online)|web\s+search|browse(?:\s+the)?\s+web|research(?:\s+online)?|online|latest|current(?:ly)?|recent|today|right\s+now|real[- ]time|breaking\s+news|news|stock\s+price|exchange\s+rate|weather|forecast)\b/i;

/** Classify only bounded prompt text; returns labels and signal counts, never prompt content. */
export function classifyRoutingTask(prompt) {
  const boundedPrompt =
    typeof prompt !== 'string' ? '' : prompt.length <= 12_000 ? prompt : `${prompt.slice(0, 6_000)}\n${prompt.slice(-6_000)}`;
  const qualitySignals = QUALITY_TASK_SIGNALS.reduce(
    (score, signal) => score + (signal.pattern.test(boundedPrompt) ? signal.weight : 0),
    0,
  );
  const speedSignals = SPEED_TASK_SIGNALS.reduce((score, signal) => score + (signal.pattern.test(boundedPrompt) ? signal.weight : 0), 0);
  const intent =
    qualitySignals >= 2 && qualitySignals > speedSignals
      ? 'quality'
      : speedSignals >= 2 && speedSignals > qualitySignals
        ? 'speed'
        : 'balanced';
  return { intent, quality_signals: qualitySignals, speed_signals: speedSignals };
}

/** Build a bounded routing-only view of the recent user request and its short follow-up context. */
export function buildRoutingPrompt(messages, prompt) {
  const previous = Array.isArray(messages)
    ? messages
        .filter((message) => message.role === 'user' && typeof message.content === 'string')
        .slice(-3)
        .map((message) => message.content.slice(-4_000))
    : [];
  return [...previous, typeof prompt === 'string' ? prompt.slice(-4_000) : ''].join('\n').slice(-12_000);
}

/** Require tool-capable models for implementation requests while keeping ordinary Q&A available to text-only profiles. */
export function requiresToolsForTask(taskType, prompt) {
  if (taskType !== 'agent') return true;
  const boundedPrompt =
    typeof prompt !== 'string' ? '' : prompt.length <= 12_000 ? prompt : `${prompt.slice(0, 6_000)}\n${prompt.slice(-6_000)}`;
  const currentWeatherIntent = /\b(?:weather|wether|forecast|temperature|rain|snow)\b/i.test(boundedPrompt);
  return (
    currentWeatherIntent ||
    LIVE_LOOKUP_INTENT.test(boundedPrompt) ||
    (TOOL_ACTION_PATTERN.test(boundedPrompt) && TOOL_SUBJECT_PATTERN.test(boundedPrompt))
  );
}

export function selectModel(
  config,
  { requestedModel, estimatedTokens = 0, requireTools = false, requireVision = false, taskType = 'agent', taskPrompt } = {},
) {
  const models = config.models || {};
  if (!Object.keys(models).length) throw new Error('No models are configured. Add at least one [models.name] table to your config.');
  const factors = {
    required_context_tokens: estimatedTokens,
    required_tools: requireTools,
    required_vision: requireVision,
    automatic_routing_enabled: config.routing?.enabled !== false,
    prefer_local: config.routing?.prefer_local !== false,
    strategy: config.routing?.selection || 'balanced',
    configured_default: config.default_model || null,
  };

  if (requestedModel) {
    const model = models[requestedModel];
    if (!model) throw new Error(`Requested model '${requestedModel}' is not configured`);
    if ((model.context_length || Infinity) < estimatedTokens)
      throw new Error(`Model '${requestedModel}' has insufficient context for this request`);
    if (requireTools && model.supports_tools === false) throw new Error(`Model '${requestedModel}' does not support required tool use`);
    if (requireVision && model.supports_vision !== true) throw new Error(`Model '${requestedModel}' is not configured for image input`);
    return {
      name: requestedModel,
      config: model,
      reason: 'explicit user override',
      factors: {
        ...factors,
        pricing_data_status: modelPricingDataStatus(model),
        capability_data_status: modelCapabilitiesDataStatus(model),
      },
      alternatives: [],
    };
  }

  const preferredName = config.default_model;
  const preferLocal = config.routing?.prefer_local !== false;
  const configuredStrategy = config.routing?.selection || 'balanced';
  const minimumContext = Math.max(estimatedTokens, config.routing?.minimum_context_tokens || 0);
  const fallbackChain = config.routing?.fallback_chain;
  if (
    fallbackChain !== undefined &&
    (!Array.isArray(fallbackChain) || fallbackChain.length === 0 || fallbackChain.some((name) => typeof name !== 'string' || !models[name]))
  ) {
    throw new TypeError('routing.fallback_chain must be a non-empty list of configured model profile names');
  }
  if (fallbackChain && new Set(fallbackChain).size !== fallbackChain.length)
    throw new TypeError('routing.fallback_chain cannot contain duplicate model names');
  if (config.routing?.enabled === false) {
    const orderedNames = fallbackChain
      ? [...new Set([...(preferredName && models[preferredName] ? [preferredName] : []), ...fallbackChain])]
      : [preferredName && models[preferredName] ? preferredName : Object.keys(models)[0]];
    const evaluated = orderedNames.map((name) => {
      const model = models[name];
      const rejection = modelRejection(model, { minimumContext, requireTools, requireVision });
      return { name, model, eligible: rejection === null, reason: rejection };
    });
    const selected = evaluated.find((item) => item.eligible);
    if (!selected) {
      const details = evaluated.map((item) => `${item.name}: ${item.reason || 'eligible'}`).join('; ');
      throw new Error(`Automatic routing is disabled and no pinned profile satisfies this request${details ? ` (${details})` : ''}`);
    }
    factors.strategy = 'disabled';
    factors.pricing_data_status = modelPricingDataStatus(selected.model);
    factors.capability_data_status = modelCapabilitiesDataStatus(selected.model);
    return {
      name: selected.name,
      config: selected.model,
      reason:
        selected.name === preferredName
          ? 'automatic routing disabled; configured default model'
          : fallbackChain
            ? `automatic routing disabled; configured fallback ${orderedNames.indexOf(selected.name) + 1}`
            : 'automatic routing disabled; first configured model',
      factors,
      alternatives: evaluated
        .filter((item) => item.name !== selected.name)
        .map(({ name, eligible, reason }) => ({ name, eligible, ...(reason ? { reason } : {}) })),
    };
  }
  const classifierEnabled = config.routing?.classifier?.enabled !== false;
  const classification = classifierEnabled && typeof taskPrompt === 'string' ? classifyRoutingTask(taskPrompt) : null;
  const classifierCanSelect =
    classification !== null &&
    !fallbackChain &&
    taskType === 'agent' &&
    configuredStrategy === 'balanced' &&
    classification.intent !== 'balanced';
  const strategy = classifierCanSelect ? classification.intent : configuredStrategy;
  const useCodingSpecialistTieBreak =
    requireTools && taskType === 'agent' && (strategy === 'quality' || (classifierCanSelect && classification?.intent === 'quality'));
  factors.strategy = strategy;
  if (classification) {
    factors.task_classification = {
      intent: classification.intent,
      quality_signals: classification.quality_signals,
      speed_signals: classification.speed_signals,
      applied: classifierCanSelect,
      ...(classifierCanSelect
        ? {}
        : {
            reason: fallbackChain
              ? 'strict fallback chain preserves configured order'
              : taskType !== 'agent'
                ? 'run mode has its own routing behavior'
                : configuredStrategy !== 'balanced'
                  ? 'configured routing strategy takes precedence'
                  : 'prompt signals were inconclusive',
          }),
    };
  }
  const candidateNames = fallbackChain
    ? [...new Set([...(preferredName && models[preferredName] ? [preferredName] : []), ...fallbackChain])]
    : Object.keys(models);
  const evaluated = candidateNames.map((name) => {
    const model = models[name];
    const rejection = modelRejection(model, { minimumContext, requireTools, requireVision });
    return { name, model, eligible: rejection === null, reason: rejection };
  });
  const candidates = evaluated
    .filter((item) => item.eligible)
    .map(({ name, model }) => [name, model])
    .sort(([nameA, modelA], [nameB, modelB]) => {
      if (fallbackChain) return candidateNames.indexOf(nameA) - candidateNames.indexOf(nameB);
      const toolCapableA = modelA.supports_tools !== false;
      const toolCapableB = modelB.supports_tools !== false;
      if (toolCapableA !== toolCapableB) return toolCapableA ? -1 : 1;
      if (preferLocal && Boolean(modelA.local) !== Boolean(modelB.local)) return modelA.local ? -1 : 1;
      const qualityA = modelQuality(modelA, { requireTools, taskType });
      const qualityB = modelQuality(modelB, { requireTools, taskType });
      const speedA = modelA.speed_score ?? 5;
      const speedB = modelB.speed_score ?? 5;
      const costA = estimateModelCost(modelA, estimatedTokens, config.budgets?.max_output_tokens || 2_000);
      const costB = estimateModelCost(modelB, estimatedTokens, config.budgets?.max_output_tokens || 2_000);
      if (taskType === 'review' && strategy === 'balanced' && qualityA !== qualityB) return qualityB - qualityA;
      if (strategy === 'quality' && qualityA !== qualityB) return qualityB - qualityA;
      if (useCodingSpecialistTieBreak && qualityA === qualityB) {
        const codingSpecialistA = hasCodingSpecialistIdentity(modelA);
        const codingSpecialistB = hasCodingSpecialistIdentity(modelB);
        if (codingSpecialistA !== codingSpecialistB) return codingSpecialistA ? -1 : 1;
      }
      if (strategy === 'speed' && speedA !== speedB) return speedB - speedA;
      if (strategy === 'cost' && costA !== costB) return costA === null ? 1 : costB === null ? -1 : costA - costB;
      if (strategy === 'balanced' && requireTools && taskType === 'agent' && qualityA !== qualityB) return qualityB - qualityA;
      if (nameA === preferredName) return -1;
      if (nameB === preferredName) return 1;
      const priorityDifference = (modelA.priority ?? 100) - (modelB.priority ?? 100);
      if (priorityDifference) return priorityDifference;
      if (strategy === 'balanced' && speedA !== speedB) return speedB - speedA;
      if (costA !== costB) return costA === null ? 1 : costB === null ? -1 : costA - costB;
      return nameA.localeCompare(nameB);
    });
  const [name, model] = candidates[0] || [];
  if (!model) {
    const details = evaluated.map((item) => `${item.name}: ${item.reason || 'eligible'}`).join('; ');
    const requirements = [
      `at least ${minimumContext} context tokens`,
      ...(requireTools ? ['tool calling'] : []),
      ...(requireVision ? ['image input'] : []),
    ];
    throw new Error(`No configured model satisfies ${requirements.join(', ')}${details ? ` (considered ${details})` : ''}`);
  }
  const selectedIndex = candidateNames.indexOf(name);
  factors.pricing_data_status = modelPricingDataStatus(model);
  factors.capability_data_status = modelCapabilitiesDataStatus(model);
  const codingSpecialistTieBreak =
    useCodingSpecialistTieBreak &&
    hasCodingSpecialistIdentity(model) &&
    evaluated.some(
      (item) =>
        item.eligible &&
        item.name !== name &&
        !hasCodingSpecialistIdentity(item.model) &&
        modelQuality(item.model, { requireTools, taskType }) === modelQuality(model, { requireTools, taskType }),
    );
  const reason =
    (classifierCanSelect
      ? name === preferredName
        ? `configured default model; prompt classifier favored ${strategy}`
        : `prompt classifier favored ${strategy} among configured models`
      : name === preferredName
        ? 'configured default model'
        : fallbackChain
          ? `configured fallback ${selectedIndex + 1}${preferredName ? ` after ${preferredName}` : ''}`
          : taskType === 'review' && strategy === 'balanced'
            ? 'highest configured coding and tool quality for review'
            : model.local && preferLocal
              ? 'preferred capable local model'
              : strategy === 'cost'
                ? 'lowest estimated cost among capable models'
                : strategy === 'quality'
                  ? 'highest configured quality among capable models'
                  : strategy === 'speed'
                    ? 'highest configured speed among capable models'
                    : 'balanced capability and priority') +
    (codingSpecialistTieBreak ? '; code-specialized profile won an equal-score tie' : '');
  const orderedDiagnostics = fallbackChain
    ? evaluated
    : [
        ...candidates.map(([candidateName, candidateModel]) => ({
          name: candidateName,
          model: candidateModel,
          eligible: true,
          reason: null,
        })),
        ...evaluated.filter((item) => !item.eligible),
      ];
  return {
    name,
    config: model,
    reason,
    factors,
    alternatives: orderedDiagnostics
      .filter((item) => item.name !== name)
      .map(({ name: alternative, eligible, reason: rejection }) => ({
        name: alternative,
        eligible,
        ...(rejection ? { reason: rejection } : {}),
      })),
  };
}

function modelQuality(model, { requireTools, taskType }) {
  if (taskType === 'review') return ((model.coding_strength ?? 5) + (model.tool_calling_quality ?? 5)) / 2;
  if (requireTools && taskType === 'agent') return ((model.coding_strength ?? 5) + (model.tool_calling_quality ?? 5)) / 2;
  return requireTools ? (model.tool_calling_quality ?? 5) : (model.coding_strength ?? 5);
}

function hasCodingSpecialistIdentity(model) {
  const id = typeof model?.model === 'string' ? model.model.replaceAll('/', '-') : '';
  return /(?:^|[-_.])(?:coder|starcoder|codeqwen|codestral|deepseek-coder)(?=$|[-_.])/i.test(id);
}

function modelRejection(model, { minimumContext, requireTools, requireVision }) {
  if ((model.context_length || Infinity) < minimumContext)
    return `context ${model.context_length} is below required ${minimumContext} tokens`;
  if (requireTools && model.supports_tools === false) return 'required tool calling is disabled';
  if (requireVision && model.supports_vision !== true) return 'vision capability is not enabled';
  return null;
}

function estimateModelCost(model, inputTokens, outputTokens) {
  if (model.input_cost_per_million === undefined || model.output_cost_per_million === undefined) return null;
  return (inputTokens * model.input_cost_per_million + outputTokens * model.output_cost_per_million) / 1_000_000;
}

export function calculateCost(modelConfig, usage) {
  if (!usage || usage.inputTokens == null || usage.outputTokens == null) return null;
  if (modelConfig.input_cost_per_million === undefined || modelConfig.output_cost_per_million === undefined) return null;
  const inputRate = Number(modelConfig.input_cost_per_million ?? 0);
  const outputRate = Number(modelConfig.output_cost_per_million ?? 0);
  const cachedInputTokens = usage.cachedInputTokens;
  const hasValidCachedCount = Number.isSafeInteger(cachedInputTokens) && cachedInputTokens >= 0 && cachedInputTokens <= usage.inputTokens;
  const cachedInputRate = modelConfig.cached_input_cost_per_million;
  const inputCost =
    hasValidCachedCount && Number.isFinite(cachedInputRate)
      ? (usage.inputTokens - cachedInputTokens) * inputRate + cachedInputTokens * cachedInputRate
      : usage.inputTokens * inputRate;
  return (inputCost + usage.outputTokens * outputRate) / 1_000_000;
}
