import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_CAPABILITIES_STALE_AFTER_DAYS,
  MODEL_PRICING_STALE_AFTER_DAYS,
  modelCapabilitiesDataStatus,
  modelCapabilitiesStatus,
  modelPricingDataStatus,
  modelPricingStatus,
} from '../gui/model-pricing.mjs';

test('model pricing status keeps missing, stale, and current price metadata visible', () => {
  const now = Date.parse('2026-10-21T12:00:00.000Z');
  const base = { input_cost_per_million: 2, output_cost_per_million: 4 };

  assert.match(modelPricingStatus({}, { now }), /No prices configured/);
  assert.match(modelPricingStatus({ input_cost_per_million: 2 }, { now }), /Regular input and output prices/);
  assert.match(modelPricingStatus(base, { now }), /review date missing/);
  assert.match(
    modelPricingStatus({ ...base, pricing_updated_at: '2026-07-22', pricing_source: 'Official pricing page' }, { now }),
    /stale.*Official pricing page/,
  );
  assert.match(modelPricingStatus({ ...base, pricing_updated_at: '2026-10-21' }, { now }), /Prices checked 2026-10-21/);
  assert.match(modelPricingStatus({ ...base, pricing_updated_at: '2026-10-22' }, { now }), /date is in the future/);
  assert.equal(modelPricingDataStatus({ ...base, pricing_updated_at: '2026-07-23' }, { now }), 'current');
  assert.equal(modelPricingDataStatus({ ...base, pricing_updated_at: '2026-07-22' }, { now }), 'stale');
  assert.equal(MODEL_PRICING_STALE_AFTER_DAYS, 90);
});

test('model capability metadata reports unreviewed, stale, invalid, and current profiles', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z');
  const base = { context_length: 32_000, supports_tools: true, supports_vision: false };
  assert.equal(modelCapabilitiesDataStatus({}, { now }), 'unknown');
  assert.equal(modelCapabilitiesDataStatus(base, { now }), 'unreviewed');
  assert.match(modelCapabilitiesStatus(base, { now }), /review date missing/);
  assert.equal(modelCapabilitiesDataStatus({ ...base, capabilities_updated_at: '2026-04-24' }, { now }), 'stale');
  assert.match(
    modelCapabilitiesStatus({ ...base, capabilities_updated_at: '2026-04-24', capabilities_source: 'Model card' }, { now }),
    /stale.*Model card/,
  );
  assert.equal(modelCapabilitiesDataStatus({ ...base, capabilities_updated_at: '2026-10-22' }, { now }), 'current');
  assert.match(
    modelCapabilitiesStatus({ ...base, capabilities_updated_at: '2026-10-22', capabilities_source: 'Provider docs' }, { now }),
    /Capabilities checked 2026-10-22.*Provider docs/,
  );
  assert.equal(modelCapabilitiesDataStatus({ ...base, capabilities_updated_at: '2026-02-30' }, { now }), 'invalid');
  assert.equal(modelCapabilitiesDataStatus({ ...base, capabilities_updated_at: '2026-10-23' }, { now }), 'invalid');
  assert.equal(MODEL_CAPABILITIES_STALE_AFTER_DAYS, 180);
});
