const BUDGET_METRICS = [
  ['input_tokens', 'Input tokens', 'tokens', 0],
  ['output_tokens', 'Output tokens', 'tokens', 0],
  ['cost_usd', 'Estimated cost', 'USD', 4],
];

export function budgetRemainingRows(settings = {}, usage = {}) {
  if (!usage || typeof usage !== 'object' || (!usage.daily && !usage.monthly)) return [];
  const limits = settings.budgets || usage.limits || {};
  const rows = [];
  for (const [period, bucket, reservedBucket, prefix] of [
    ['Today', usage.daily, usage.reserved_daily, 'daily'],
    ['This month', usage.monthly, usage.reserved_monthly, 'monthly'],
  ]) {
    for (const [metric, label, unit, decimals] of BUDGET_METRICS) {
      const limit =
        limits[`max_${prefix}_${metric.replace('_usd', '')}`] ?? (metric === 'cost_usd' ? limits[`max_${prefix}_cost`] : undefined);
      if (!Number.isFinite(limit)) continue;
      const used = finite(bucket?.[metric]) + finite(reservedBucket?.[metric]);
      const remaining = Math.max(0, limit - used);
      rows.push({ period, label, unit, limit, used, remaining, decimals });
    }
  }
  return rows;
}

export function routingSummary(decision, profiles = {}) {
  if (!decision || typeof decision !== 'object') return null;
  const name = typeof decision.model === 'string' ? decision.model : 'Unknown profile';
  const profile = profiles[name] || {};
  return {
    profile: name,
    model: typeof profile.model === 'string' ? profile.model : null,
    provider: typeof profile.provider === 'string' ? profile.provider : null,
    locality: profile.local === true ? 'Local' : profile.local === false ? 'Remote' : 'Configured',
    reason: typeof decision.reason === 'string' ? decision.reason : 'Routing reason unavailable',
    factors: decision.factors && typeof decision.factors === 'object' ? decision.factors : {},
    alternatives: Array.isArray(decision.alternatives)
      ? decision.alternatives.slice(0, 8).map((item) => ({
          name: String(item?.name || 'Unknown'),
          eligible: item?.eligible !== false,
          reason: typeof item?.reason === 'string' ? item.reason : null,
        }))
      : [],
  };
}

function finite(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
