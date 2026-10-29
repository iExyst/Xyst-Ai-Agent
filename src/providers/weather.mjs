import { readBoundedJsonResponse } from './http-json.mjs';

const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_LOCATION_LENGTH = 120;
const US_STATES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const CONDITIONS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

/** Keyless current conditions from Open-Meteo. Location is explicit; no IP geolocation is used. */
export class OpenMeteoWeatherProvider {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.requestTimes = [];
  }

  async getWeather(location, { signal, timeoutMs = 10_000 } = {}) {
    const query = typeof location === 'string' ? location.trim() : '';
    if (!query || query.length > MAX_LOCATION_LENGTH || /[\u0000-\u001f\u007f]/.test(query))
      throw new TypeError(`location must contain 1-${MAX_LOCATION_LENGTH} printable characters`);
    if (signal?.aborted) throw signal.reason || new Error('Weather lookup was cancelled');
    this.#enforceRateLimit();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
    const qualified = splitUsLocation(query);
    const geocodeUrl = new URL(GEOCODING_ENDPOINT);
    geocodeUrl.searchParams.set('name', qualified?.city || query);
    geocodeUrl.searchParams.set('count', qualified ? '100' : '5');
    if (qualified) geocodeUrl.searchParams.set('countryCode', 'US');
    geocodeUrl.searchParams.set('language', 'en');
    geocodeUrl.searchParams.set('format', 'json');
    const geocoding = await this.#getJson(geocodeUrl, requestSignal);
    const places = Array.isArray(geocoding?.results)
      ? geocoding.results
          .filter((place) => validPlace(place) && (!qualified || (place.country_code === 'US' && place.admin1 === qualified.state)))
          .slice(0, 5)
      : [];
    if (!places.length) return { provider: 'open-meteo', found: false, location: query };
    if (
      places.length > 1 &&
      places
        .slice(1)
        .some((place) => place.name.toLowerCase() === places[0].name.toLowerCase() && placeLabel(place) !== placeLabel(places[0]))
    )
      return { provider: 'open-meteo', found: false, ambiguous: true, location: query, matches: places.map(placeLabel) };
    const place = places[0];
    const forecastUrl = new URL(FORECAST_ENDPOINT);
    forecastUrl.searchParams.set('latitude', String(place.latitude));
    forecastUrl.searchParams.set('longitude', String(place.longitude));
    forecastUrl.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m',
    );
    forecastUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    forecastUrl.searchParams.set('forecast_days', '1');
    forecastUrl.searchParams.set('timezone', 'auto');
    const forecast = await this.#getJson(forecastUrl, requestSignal);
    const current = forecast?.current;
    if (!current || !Number.isFinite(current.temperature_2m)) throw new Error('Weather provider returned incomplete current conditions');
    return {
      provider: 'open-meteo',
      found: true,
      place: placeLabel(place),
      timezone: forecast.timezone || null,
      observed_at: current.time || null,
      condition: CONDITIONS[current.weather_code] || 'Unknown conditions',
      temperature: current.temperature_2m,
      temperature_unit: forecast.current_units?.temperature_2m || '°C',
      feels_like: current.apparent_temperature ?? null,
      humidity_percent: current.relative_humidity_2m ?? null,
      wind_speed: current.wind_speed_10m ?? null,
      wind_speed_unit: forecast.current_units?.wind_speed_10m || 'km/h',
      wind_direction_degrees: current.wind_direction_10m ?? null,
      precipitation_probability_percent: forecast.daily?.precipitation_probability_max?.[0] ?? null,
      today_high: forecast.daily?.temperature_2m_max?.[0] ?? null,
      today_low: forecast.daily?.temperature_2m_min?.[0] ?? null,
      daily_temperature_unit: forecast.daily_units?.temperature_2m_max || '°C',
      source_url: 'https://open-meteo.com/',
    };
  }

  async #getJson(url, signal) {
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Weather lookup failed with HTTP ${response.status}`);
    return readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, 'Weather provider response');
  }

  #enforceRateLimit() {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
    if (this.requestTimes.length >= 10) throw new Error('Weather lookup is limited to 10 requests per minute');
    this.requestTimes.push(now);
  }
}

function splitUsLocation(query) {
  for (const [code, state] of Object.entries(US_STATES).sort((a, b) => b[1].length - a[1].length)) {
    for (const suffix of [code, state]) {
      if (!query.toLowerCase().endsWith(` ${suffix.toLowerCase()}`)) continue;
      const city = query.slice(0, -suffix.length).trim().replace(/,$/, '').trim();
      if (city) return { city, state };
    }
  }
  return null;
}

function validPlace(place) {
  return (
    place &&
    Number.isFinite(place.latitude) &&
    Number.isFinite(place.longitude) &&
    place.latitude >= -90 &&
    place.latitude <= 90 &&
    place.longitude >= -180 &&
    place.longitude <= 180 &&
    typeof place.name === 'string' &&
    place.name.length <= 100
  );
}

function placeLabel(place) {
  return [place.name, place.admin1, place.country]
    .filter((part, index, all) => typeof part === 'string' && part && all.indexOf(part) === index)
    .join(', ');
}
