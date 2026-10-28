import { requiresToolsForTask, selectModel } from './router.mjs';

export function validateRoutingDataset(dataset) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset))
    throw new TypeError('Expected a versioned routing dataset with schema_version, dataset_version, and cases');
  if (
    dataset.schema_version !== 1 ||
    typeof dataset.dataset_version !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(dataset.dataset_version)
  )
    throw new TypeError('Expected a versioned routing dataset with schema_version, dataset_version, and cases');
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) throw new TypeError('Routing dataset cases must be a non-empty array');
  return dataset;
}

/** Evaluate labeled routing examples without contacting providers or exposing configuration. */
export function evaluateRoutingCases(cases, { failFast = false } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('Routing evaluation dataset must be a non-empty array');
  const seen = new Set();
  const results = cases.map((example, index) => {
    validateCase(example, index);
    if (seen.has(example.id)) throw new TypeError(`Duplicate routing evaluation case id '${example.id}'`);
    seen.add(example.id);
    let selectedModel = null;
    let error = null;
    const selectionOptions = { ...(example.options || {}) };
    const taskType = selectionOptions.taskType || 'agent';
    const promptRequiresTools =
      typeof selectionOptions.taskPrompt === 'string' ? requiresToolsForTask(taskType, selectionOptions.taskPrompt) : taskType !== 'agent';
    if (!Object.hasOwn(selectionOptions, 'requireTools')) selectionOptions.requireTools = promptRequiresTools;
    try {
      selectedModel = selectModel(example.config, selectionOptions).name;
    } catch (cause) {
      error = cause.message;
    }
    const classifierCanApply =
      example.config.routing?.classifier?.enabled !== false &&
      typeof example.options?.taskPrompt === 'string' &&
      !example.options?.requestedModel &&
      !example.config.routing?.fallback_chain &&
      taskType === 'agent' &&
      (example.config.routing?.selection || 'balanced') === 'balanced';
    let baselineModel = null;
    let baselineError = null;
    if (classifierCanApply) {
      try {
        const baselineConfig = structuredClone(example.config);
        baselineConfig.routing = { ...baselineConfig.routing, classifier: { enabled: false } };
        baselineModel = selectModel(baselineConfig, selectionOptions).name;
      } catch (cause) {
        baselineError = cause.message;
      }
    }
    const baselinePassed =
      !baselineError && (example.expected_baseline_model === undefined || baselineModel === example.expected_baseline_model);
    const toolRequirementPassed = example.expected_require_tools === undefined || promptRequiresTools === example.expected_require_tools;
    const passed = selectedModel === example.expected_model && baselinePassed && toolRequirementPassed;
    const classifierComparison =
      classifierCanApply && !baselineError
        ? selectedModel === example.expected_model && baselineModel !== example.expected_model
          ? 'improved'
          : selectedModel !== example.expected_model && baselineModel === example.expected_model
            ? 'regressed'
            : 'unchanged'
        : null;
    const result = {
      id: example.id,
      category: example.category,
      expected_model: example.expected_model,
      selected_model: selectedModel,
      required_tools: promptRequiresTools,
      ...(example.expected_require_tools === undefined ? {} : { expected_require_tools: example.expected_require_tools }),
      passed,
      ...(classifierComparison
        ? {
            baseline_model: baselineModel,
            ...(example.expected_baseline_model ? { expected_baseline_model: example.expected_baseline_model } : {}),
            classifier_comparison: classifierComparison,
          }
        : {}),
      ...(error ? { error } : {}),
      ...(baselineError ? { baseline_error: baselineError } : {}),
    };
    if (failFast && !passed) throw new Error(formatMismatch(result));
    return result;
  });

  const categories = Object.create(null);
  for (const result of results) {
    const category = (categories[result.category] ||= { total: 0, passed: 0 });
    category.total += 1;
    if (result.passed) category.passed += 1;
  }
  const passed = results.filter((result) => result.passed).length;
  const classifierResults = results.filter((result) => result.classifier_comparison);
  const classifierMatches = classifierResults.filter((result) => result.selected_model === result.expected_model).length;
  const baselineMatches = classifierResults.filter((result) => result.baseline_model === result.expected_model).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    accuracy: passed / results.length,
    by_category: Object.fromEntries(
      Object.entries(categories)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, metrics]) => [category, { ...metrics, accuracy: metrics.passed / metrics.total }]),
    ),
    classifier_comparison: classifierResults.length
      ? {
          total: classifierResults.length,
          improved: classifierResults.filter((result) => result.classifier_comparison === 'improved').length,
          regressed: classifierResults.filter((result) => result.classifier_comparison === 'regressed').length,
          unchanged: classifierResults.filter((result) => result.classifier_comparison === 'unchanged').length,
          baseline_accuracy: baselineMatches / classifierResults.length,
          classifier_accuracy: classifierMatches / classifierResults.length,
        }
      : null,
    results,
  };
}

export function formatMismatch(result) {
  return `${result.id}: expected '${result.expected_model}', selected ${result.selected_model === null ? 'no model' : `'${result.selected_model}'`}${result.error ? ` (${result.error})` : ''}${result.expected_baseline_model && result.baseline_model !== result.expected_baseline_model ? `; baseline expected '${result.expected_baseline_model}', selected ${result.baseline_model === null ? 'no model' : `'${result.baseline_model}'`}` : ''}${result.baseline_error ? ` (baseline: ${result.baseline_error})` : ''}`;
}

function validateCase(example, index) {
  if (!example || typeof example !== 'object' || Array.isArray(example))
    throw new TypeError(`Routing evaluation case ${index} must be an object`);
  if (typeof example.id !== 'string' || !example.id.trim()) throw new TypeError(`Routing evaluation case ${index} needs a non-empty id`);
  if (typeof example.category !== 'string' || !example.category.trim())
    throw new TypeError(`Routing evaluation case '${example.id}' needs a category`);
  if (typeof example.expected_model !== 'string' || !example.expected_model.trim())
    throw new TypeError(`Routing evaluation case '${example.id}' needs an expected_model`);
  if (
    example.expected_baseline_model !== undefined &&
    (typeof example.expected_baseline_model !== 'string' || !example.expected_baseline_model.trim())
  )
    throw new TypeError(`Routing evaluation case '${example.id}' expected_baseline_model must be a non-empty string`);
  if (example.expected_require_tools !== undefined && typeof example.expected_require_tools !== 'boolean')
    throw new TypeError(`Routing evaluation case '${example.id}' expected_require_tools must be a boolean`);
  if (
    !example.config ||
    typeof example.config !== 'object' ||
    Array.isArray(example.config) ||
    !example.config.models ||
    typeof example.config.models !== 'object' ||
    Array.isArray(example.config.models)
  ) {
    throw new TypeError(`Routing evaluation case '${example.id}' needs a config with model profiles`);
  }
  if (example.options !== undefined && (!example.options || typeof example.options !== 'object' || Array.isArray(example.options)))
    throw new TypeError(`Routing evaluation case '${example.id}' options must be an object`);
}
