import { MODEL_PRICING_STALE_AFTER_DAYS, modelPricingDataStatus } from '../src/core/model-pricing.mjs';
import { MODEL_CAPABILITIES_STALE_AFTER_DAYS, modelCapabilitiesDataStatus, modelCapabilitiesStatus } from '../src/core/model-metadata.mjs';

export { MODEL_PRICING_STALE_AFTER_DAYS, modelPricingDataStatus };
export { MODEL_CAPABILITIES_STALE_AFTER_DAYS, modelCapabilitiesDataStatus, modelCapabilitiesStatus };

export function modelPricingStatus(profile, { now = Date.now() } = {}) {
  const status = modelPricingDataStatus(profile, { now });
  const hasAnyPrice = ['input_cost_per_million', 'cached_input_cost_per_million', 'output_cost_per_million'].some((key) =>
    Number.isFinite(profile[key]),
  );
  if (!hasAnyPrice) return 'No prices configured; cost budgets need regular input and output prices.';
  if (!Number.isFinite(profile.input_cost_per_million) || !Number.isFinite(profile.output_cost_per_million))
    return 'Regular input and output prices are needed for cost budgets.';
  const source = profile.pricing_source ? ` · Source: ${profile.pricing_source}` : '';
  if (status === 'unreviewed') return 'Price review date missing; cost estimates may be stale.';
  if (status === 'invalid') {
    const reviewedAt = Date.parse(`${profile.pricing_updated_at}T00:00:00.000Z`);
    const reason = Number.isFinite(reviewedAt) && reviewedAt > now ? 'in the future' : 'invalid';
    return `Price review date is ${reason}; correct it before relying on estimates.${source}`;
  }
  if (status === 'stale')
    return `Prices last checked ${profile.pricing_updated_at} · stale (over ${MODEL_PRICING_STALE_AFTER_DAYS} days old)${source}`;
  return `Prices checked ${profile.pricing_updated_at}${source}`;
}
