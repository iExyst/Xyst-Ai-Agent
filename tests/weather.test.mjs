import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenMeteoWeatherProvider } from '../src/providers/weather.mjs';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { TOOL_DEFINITIONS, validateArguments } from '../src/tools/schemas.mjs';
import { requiresToolsForTask } from '../src/core/router.mjs';

test('weather provider geocodes the requested city and returns live current and daily fields without a key', async () => {
  const requests = [];
  const provider = new OpenMeteoWeatherProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1)
        return Response.json({
          results: [
            { name: 'Boston', admin1: 'Massachusetts', country: 'United States', country_code: 'US', latitude: 42.36, longitude: -71.06 },
          ],
        });
      return Response.json({
        timezone: 'America/New_York',
        current: {
          time: '2026-10-25T09:00',
          temperature_2m: 12,
          apparent_temperature: 10,
          relative_humidity_2m: 55,
          weather_code: 2,
          wind_speed_10m: 14,
          wind_direction_10m: 90,
        },
        current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
        daily: { temperature_2m_max: [16], temperature_2m_min: [8], precipitation_probability_max: [20] },
        daily_units: { temperature_2m_max: '°C' },
      });
    },
  });
  const result = await provider.getWeather('Boston');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(requests[0].url.searchParams.get('name'), 'Boston');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[1].url.origin, 'https://api.open-meteo.com');
  assert.equal(requests[1].url.searchParams.get('timezone'), 'auto');
  assert.deepEqual(result, {
    provider: 'open-meteo',
    found: true,
    place: 'Boston, Massachusetts, United States',
    timezone: 'America/New_York',
    observed_at: '2026-10-25T09:00',
    condition: 'Partly cloudy',
    temperature: 12,
    temperature_unit: '°C',
    feels_like: 10,
    humidity_percent: 55,
    wind_speed: 14,
    wind_speed_unit: 'km/h',
    wind_direction_degrees: 90,
    precipitation_probability_percent: 20,
    today_high: 16,
    today_low: 8,
    daily_temperature_unit: '°C',
    source_url: 'https://open-meteo.com/',
  });
  assert.ok(requests.every(({ options }) => !options.headers?.authorization && !options.headers?.['x-api-key']));
});

test('weather resolves city and state qualifiers without choosing a same-name city in another state', async () => {
  for (const location of ['Laconia NH', 'Laconia, NH', 'Laconia, New Hampshire']) {
    const requests = [];
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: async (url) => {
        const target = new URL(url);
        requests.push(target);
        if (requests.length === 1) {
          assert.equal(target.searchParams.get('name'), 'Laconia');
          assert.equal(target.searchParams.get('countryCode'), 'US');
          return Response.json({
            results: [
              { name: 'Laconia', admin1: 'Indiana', country: 'United States', country_code: 'US', latitude: 38, longitude: -86 },
              {
                name: 'Laconia',
                admin1: 'New Hampshire',
                country: 'United States',
                country_code: 'US',
                latitude: 43.53,
                longitude: -71.47,
              },
            ],
          });
        }
        assert.equal(target.searchParams.get('latitude'), '43.53');
        return Response.json({ current: { temperature_2m: 12 } });
      },
    });
    const result = await provider.getWeather(location);
    assert.equal(result.found, true);
    assert.equal(result.place, 'Laconia, New Hampshire, United States');
  }
  const missing = new OpenMeteoWeatherProvider({
    fetchImpl: async () =>
      Response.json({ results: [{ name: 'Laconia', admin1: 'Indiana', country_code: 'US', latitude: 38, longitude: -86 }] }),
  });
  assert.equal((await missing.getWeather('Laconia NH')).found, false);
});

test('weather rejects bad locations, asks for disambiguation, and bounds provider responses', async () => {
  let calls = 0;
  const provider = new OpenMeteoWeatherProvider({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ results: [] });
    },
  });
  await assert.rejects(provider.getWeather(''), /location must contain/);
  await assert.rejects(provider.getWeather('x'.repeat(121)), /location must contain/);
  assert.equal(calls, 0);
  assert.deepEqual(await provider.getWeather('Springfield'), { provider: 'open-meteo', found: false, location: 'Springfield' });

  const ambiguous = new OpenMeteoWeatherProvider({
    fetchImpl: async () =>
      Response.json({
        results: [
          { name: 'Springfield', country: 'United States', country_code: 'US', latitude: 1, longitude: 2 },
          { name: 'Springfield', country: 'Australia', country_code: 'AU', latitude: 3, longitude: 4 },
        ],
      }),
  });
  const result = await ambiguous.getWeather('Springfield');
  assert.equal(result.ambiguous, true);
  assert.equal(result.matches.length, 2);

  const oversized = new OpenMeteoWeatherProvider({ fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) });
  await assert.rejects(oversized.getWeather('Boston'), /262144-byte limit/);
});

test('weather tool is available by default, asks in assisted mode, and is routed for weather queries', async () => {
  assert.equal(TOOL_DEFINITIONS.get_weather.approval, 'ask');
  assert.equal(validateArguments(TOOL_DEFINITIONS.get_weather.parameters, '{"location":"Boston"}').location, 'Boston');
  assert.throws(() => validateArguments(TOOL_DEFINITIONS.get_weather.parameters, '{}'), /location is required/);
  assert.equal(requiresToolsForTask('agent', 'What is the weather today in Boston?'), true);
  assert.equal(requiresToolsForTask('agent', 'whats the wether today'), true);
  let location;
  const tools = createBuiltinTools({
    workspaceRoot: '.',
    weatherProvider: {
      getWeather: async (value) => {
        location = value;
        return { found: true };
      },
    },
  });
  assert.equal(tools.has('get_weather'), true);
  assert.deepEqual(JSON.parse(await tools.call('get_weather', { location: 'Boston' }, {})), { found: true });
  assert.equal(location, 'Boston');
});
