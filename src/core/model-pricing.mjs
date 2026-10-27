export const MODEL_PRICING_STALE_AFTER_DAYS = 90;

export function modelPricingDataStatus(profile, { now = Date.now() } = {}) {
  if (!Number.isFinite(profile.input_cost_per_million) || !Number.isFinite(profile.output_cost_per_million)) return 'unknown';
  if (!profile.pricing_updated_at) return 'unreviewed';
  const reviewedAt = Date.parse(`${profile.pricing_updated_at}T00:00:00.000Z`);
  if (!Number.isFinite(reviewedAt) || reviewedAt > now) return 'invalid';
  return Math.floor((now - reviewedAt) / 86_400_000) > MODEL_PRICING_STALE_AFTER_DAYS ? 'stale' : 'current';
}
