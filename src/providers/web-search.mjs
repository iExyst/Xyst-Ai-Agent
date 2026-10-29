import { resolveModelApiKey } from '../config/load.mjs';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const WIKIPEDIA_ENDPOINT = 'https://en.wikipedia.org/w/api.php';
const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GOOGLE_NEWS_RSS_ENDPOINT = 'https://news.google.com/rss/search';
const DUCKDUCKGO_ENDPOINT = 'https://html.duckduckgo.com/html/';
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 10;
const MAX_RESULT_TEXT = 1200;
const MAX_RSS_RESPONSE_BYTES = 1024 * 1024;
const GDELT_CACHE_TTL_MS = 60_000;
const GDELT_CACHE_MAX_ENTRIES = 64;
const gdeltResultCache = new Map();

/** Explicitly configured Brave Search adapter. Queries require tool approval. */
export class BraveWebSearchProvider {
  constructor({ config, fetchImpl = fetch, secretStore, env = process.env, now = Date.now } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.secretStore = secretStore;
    this.env = env;
    this.now = now;
    this.requestTimes = [];
  }

  async search(query, { signal, timeoutMs = this.config.timeout_ms || 10_000 } = {}) {
    if (!this.config?.enabled) throw new Error('Web search is disabled in configuration');
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
      throw new TypeError(`query must contain 1-${MAX_QUERY_LENGTH} printable characters`);
    }
    if (signal?.aborted) throw signal.reason || new Error('Web search was cancelled');
    let apiKey;
    try {
      apiKey = await resolveModelApiKey(this.config, { secretStore: this.secretStore, env: this.env });
    } catch (error) {
      if (this.config.api_key_secret) throw missingSearchCredential(error);
      throw error;
    }
    if (!apiKey) throw missingSearchCredential();
    if (signal?.aborted) throw signal.reason || new Error('Web search was cancelled');
    this.#enforceRateLimit();
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('count', String(Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS)));
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      redirect: 'error',
    });
    if (!response.ok) {
      const authenticationFailed = response.status === 401 || response.status === 403;
      const error = new Error(
        authenticationFailed
          ? 'Web search authentication failed; check the configured credential'
          : response.status === 429
            ? 'Web search rate limit reached'
            : `Web search failed with HTTP ${response.status}`,
      );
      error.code = response.status === 429 ? 'WEB_SEARCH_RATE_LIMITED' : 'WEB_SEARCH_FAILED';
      if (authenticationFailed) error.code = 'WEB_SEARCH_AUTH_FAILED';
      throw error;
    }
    const body = await readJsonLimited(response, 2 * 1024 * 1024);
    const entries = Array.isArray(body?.web?.results) ? body.web.results : [];
    const results = entries.slice(0, Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS)).flatMap((entry) => {
      const target = safeResultUrl(entry.url);
      if (!target || typeof entry.title !== 'string' || typeof entry.description !== 'string') return [];
      return [{ title: cleanText(entry.title, 300), url: target, snippet: cleanText(entry.description, MAX_RESULT_TEXT) }];
    });
    return { provider: 'brave', query: query.trim(), results };
  }

  #enforceRateLimit() {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
    if (this.requestTimes.length >= 10) {
      const error = new Error('Web search is limited to 10 requests per minute');
      error.code = 'WEB_SEARCH_RATE_LIMITED';
      throw error;
    }
    this.requestTimes.push(now);
  }
}

/** Fall back to keyless search when the optional Brave credential is missing or rejected. */
export class KeylessFallbackWebSearchProvider {
  constructor({ primary, fallback } = {}) {
    if (!primary || !fallback) throw new TypeError('Both primary and fallback web search providers are required');
    this.primary = primary;
    this.fallback = fallback;
  }

  async search(query, options) {
    try {
      return await this.primary.search(query, options);
    } catch (error) {
      if (!['WEB_SEARCH_CREDENTIAL_MISSING', 'WEB_SEARCH_AUTH_FAILED'].includes(error.code)) throw error;
      return this.fallback.search(query, options);
    }
  }
}

/** Keyless live search across recent global news and reference sources. */
export class AutomaticWebSearchProvider {
  constructor({ general, news, reference, maxResults = MAX_RESULTS } = {}) {
    if (!news || !reference) throw new TypeError('News and reference search providers are required');
    this.news = Array.isArray(news) ? news : [news];
    if (this.news.some((provider) => !provider || typeof provider.search !== 'function'))
      throw new TypeError('Every news search provider must implement search');
    this.reference = reference;
    this.general = general;
    this.maxResults = Math.min(MAX_RESULTS, Math.max(1, maxResults));
  }

  async search(query, options) {
    const providers = [...(this.general ? [this.general] : []), ...this.news, this.reference];
    const settled = await Promise.allSettled(providers.map((provider) => provider.search(query, options)));
    const available = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (!available.length)
      throw new AggregateError(
        settled.map((result) => result.reason),
        'Automatic web search does not require an API key, but no public search source responded. Check your internet connection or source availability.',
      );
    const seen = new Set();
    const results = [];
    for (const result of available) {
      for (const entry of result.results) {
        const key = canonicalResultUrl(entry.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push({ ...entry, source: result.provider });
        if (results.length >= this.maxResults) break;
      }
      if (results.length >= this.maxResults) break;
    }
    return {
      provider: 'automatic',
      query: query.trim(),
      results,
      sources: available.map((result) => result.provider),
      unavailable_sources: settled.flatMap((result, index) =>
        result.status === 'rejected'
          ? [providers[index].sourceName || (index === providers.length - 1 ? 'wikipedia' : this.news.length === 1 ? 'gdelt' : 'news')]
          : [],
      ),
    };
  }
}

/** General public web results, without a required API key. */
export class DuckDuckGoWebSearchProvider {
  constructor({ config = {}, fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sourceName = 'duckduckgo';
    this.requestTimes = [];
  }

  async search(query, { signal, timeoutMs = this.config.timeout_ms || 10_000 } = {}) {
    validateQuery(query, signal);
    enforceRequestRate(this, 'Web search', this.now());
    const url = new URL(DUCKDUCKGO_ENDPOINT);
    url.searchParams.set('q', query.trim());
    const response = await this.fetchImpl(url, {
      headers: { accept: 'text/html', 'user-agent': 'Xyst-AI-Assistant/1.0 (public web search)' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Public web search failed with HTTP ${response.status}`);
    const html = await readTextLimited(response, MAX_RSS_RESPONSE_BYTES);
    if (/anomaly\.js|challenge-form/i.test(html)) throw new Error('Public web search requires browser verification; trying other sources');
    const results = [];
    const seen = new Set();
    const anchors = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index];
      const href = anchor[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      let target;
      try {
        const link = new URL(decodeXml(href), DUCKDUCKGO_ENDPOINT);
        target = safeResultUrl(link.hostname === 'duckduckgo.com' && link.pathname === '/l/' ? link.searchParams.get('uddg') : link.href);
      } catch {
        continue;
      }
      if (!target || seen.has(target)) continue;
      const title = cleanText(decodeXml(stripHtml(anchor[0])), 300);
      if (!title) continue;
      const section = html.slice(anchor.index + anchor[0].length, anchors[index + 1]?.index ?? html.length);
      const snippet =
        section.match(/<(?:a|td|div)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)?.[1] || '';
      seen.add(target);
      results.push({ title, url: target, snippet: cleanText(decodeXml(stripHtml(snippet)), MAX_RESULT_TEXT) });
      if (results.length >= Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS)) break;
    }
    return { provider: 'duckduckgo', query: query.trim(), results };
  }
}

/** Read source pages and JSON APIs without shell quoting or parsing commands. */
export class WebPageProvider {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async read(url, { signal, timeoutMs = 10_000 } = {}) {
    let target = safeResultUrl(url);
    if (!target) throw new TypeError('url must be an HTTPS URL without embedded credentials (maximum 2048 characters)');
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await this.fetchImpl(target, {
        headers: {
          accept: 'text/html, application/json, text/plain, application/xml',
          'user-agent': 'Xyst-AI-Assistant/1.0 (source reader)',
        },
        signal: requestSignal,
        redirect: 'manual',
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        target = location ? safeResultUrl(new URL(location, target).href) : null;
        if (!target || redirects === 3) throw new Error('Source page returned an unsupported redirect');
        continue;
      }
      if (!response.ok) throw new Error(`Source page request failed with HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (!/^(?:text\/|application\/(?:json|[^; ]+\+json|xml|[^; ]+\+xml))(?:[^\r\n]*)$/i.test(type)) {
        await response.body?.cancel();
        throw new Error('Source reader supports text, HTML, XML, and JSON; this source requires a different reader');
      }
      const body = await readTextLimited(response, MAX_RSS_RESPONSE_BYTES);
      const isHtml = /text\/html/i.test(type);
      const title = isHtml ? cleanText(decodeXml(stripHtml(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')), 300) : '';
      const text = isHtml ? decodeXml(stripHtml(body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ''))) : body;
      const content = text
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        url: target,
        title,
        fetched_at: new Date().toISOString(),
        content: content.slice(0, 12_000),
        truncated: content.length > 12_000,
      };
    }
  }
}

/** Keyless recent-news search backed by the GDELT DOC 2.0 API. */
export class GdeltWebSearchProvider {
  constructor({ config = {}, fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sourceName = 'gdelt';
    this.requestTimes = [];
  }

  async search(query, { signal, timeoutMs = this.config.timeout_ms || 10_000 } = {}) {
    validateQuery(query, signal);
    const normalizedQuery = query.trim();
    const maxResults = Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS);
    const cacheKey = `${maxResults}:${normalizedQuery.toLocaleLowerCase('en-US')}`;
    const cached = gdeltResultCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return { provider: 'gdelt', query: normalizedQuery, results: structuredClone(cached.results) };
    }
    if (cached) gdeltResultCache.delete(cacheKey);
    this.#enforceRateLimit();
    const url = new URL(GDELT_ENDPOINT);
    for (const [key, value] of Object.entries({
      query: normalizedQuery,
      mode: 'artlist',
      format: 'json',
      maxrecords: String(maxResults),
      timespan: '1week',
      sort: 'datedesc',
    }))
      url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'Xyst-AI-Assistant/1.0 (keyless live news search)' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GDELT news search failed with HTTP ${response.status}`);
    const body = await readJsonLimited(response, 2 * 1024 * 1024);
    const articles = Array.isArray(body?.articles) ? body.articles : [];
    const results = articles.slice(0, maxResults).flatMap((article) => {
      const target = safeResultUrl(article?.url);
      if (!target || typeof article?.title !== 'string') return [];
      const date = typeof article.seendate === 'string' && /^\d{14}$/.test(article.seendate) ? article.seendate : '';
      const domain = typeof article.domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(article.domain) ? article.domain : '';
      const snippet = [
        domain,
        date && `Seen ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${date.slice(8, 10)}:${date.slice(10, 12)} UTC`,
      ]
        .filter(Boolean)
        .join(' · ');
      return [{ title: cleanText(article.title, 300), url: target, snippet }];
    });
    while (gdeltResultCache.size >= GDELT_CACHE_MAX_ENTRIES) gdeltResultCache.delete(gdeltResultCache.keys().next().value);
    gdeltResultCache.set(cacheKey, { expiresAt: this.now() + GDELT_CACHE_TTL_MS, results: structuredClone(results) });
    return { provider: 'gdelt', query: normalizedQuery, results };
  }

  #enforceRateLimit() {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
    if (this.requestTimes.length >= 10) {
      const error = new Error('Web search is limited to 10 requests per minute');
      error.code = 'WEB_SEARCH_RATE_LIMITED';
      throw error;
    }
    this.requestTimes.push(now);
  }
}

/** Keyless recent-news fallback using Google News' public RSS search feed. */
export class GoogleNewsRssProvider {
  constructor({ config = {}, fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sourceName = 'google-news';
    this.requestTimes = [];
  }

  async search(query, { signal, timeoutMs = this.config.timeout_ms || 10_000 } = {}) {
    validateQuery(query, signal);
    this.#enforceRateLimit();
    const normalizedQuery = query.trim();
    const url = new URL(GOOGLE_NEWS_RSS_ENDPOINT);
    for (const [key, value] of Object.entries({ q: normalizedQuery, hl: 'en-US', gl: 'US', ceid: 'US:en' }))
      url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      headers: {
        accept: 'application/rss+xml, application/xml, text/xml',
        'user-agent': 'Xyst-AI-Assistant/1.0 (keyless live news search)',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Google News RSS search failed with HTTP ${response.status}`);
    const xml = await readTextLimited(response, MAX_RSS_RESPONSE_BYTES);
    const results = parseGoogleNewsRss(xml, Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS));
    return { provider: 'google-news', query: normalizedQuery, results };
  }

  #enforceRateLimit() {
    enforceRequestRate(this, 'Web search', this.now());
  }
}

/** Keyless public reference search backed by Wikipedia's MediaWiki API. */
export class WikipediaWebSearchProvider {
  constructor({ config, fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sourceName = 'wikipedia';
    this.requestTimes = [];
  }

  async search(query, { signal, timeoutMs = this.config.timeout_ms || 10_000 } = {}) {
    validateQuery(query, signal);
    this.#enforceRateLimit();
    const url = new URL(WIKIPEDIA_ENDPOINT);
    for (const [key, value] of Object.entries({
      action: 'query',
      list: 'search',
      srsearch: query.trim(),
      srlimit: String(Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS)),
      srprop: 'snippet',
      format: 'json',
      formatversion: '2',
      utf8: '1',
    }))
      url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'Xyst-AI-Assistant/1.0 (keyless public search)' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Wikipedia search failed with HTTP ${response.status}`);
    const body = await readJsonLimited(response, 2 * 1024 * 1024);
    const entries = Array.isArray(body?.query?.search) ? body.query.search : [];
    const references = entries.slice(0, Math.min(MAX_RESULTS, this.config.max_results || MAX_RESULTS)).flatMap((entry) => {
      if (typeof entry?.title !== 'string' || !Number.isSafeInteger(entry.pageid)) return [];
      return [
        {
          pageid: entry.pageid,
          title: cleanText(entry.title, 300),
          url: `https://en.wikipedia.org/?curid=${entry.pageid}`,
          snippet: cleanText(stripHtml(entry.snippet || ''), MAX_RESULT_TEXT),
        },
      ];
    });
    const extracts = await this.#pageExtracts(
      references.map((reference) => reference.pageid),
      { signal, timeoutMs },
    );
    const results = references.map(({ pageid, ...reference }) => ({
      ...reference,
      snippet: extracts.get(pageid) || reference.snippet,
    }));
    return { provider: 'wikipedia', query: query.trim(), results };
  }

  async #pageExtracts(pageIds, { signal, timeoutMs }) {
    if (!pageIds.length) return new Map();
    const url = new URL(WIKIPEDIA_ENDPOINT);
    for (const [key, value] of Object.entries({
      action: 'query',
      prop: 'extracts',
      pageids: pageIds.join('|'),
      exintro: '1',
      explaintext: '1',
      exchars: String(MAX_RESULT_TEXT),
      format: 'json',
      formatversion: '2',
    }))
      url.searchParams.set(key, value);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'Xyst-AI-Assistant/1.0 (keyless public search)' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
        redirect: 'error',
      });
      if (!response.ok) return new Map();
      const body = await readJsonLimited(response, 2 * 1024 * 1024);
      const pages = Array.isArray(body?.query?.pages) ? body.query.pages : [];
      return new Map(
        pages.flatMap((page) =>
          Number.isSafeInteger(page?.pageid) && typeof page.extract === 'string'
            ? [[page.pageid, cleanText(page.extract, MAX_RESULT_TEXT)]]
            : [],
        ),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return new Map();
    }
  }

  #enforceRateLimit() {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
    if (this.requestTimes.length >= 10) {
      const error = new Error('Web search is limited to 10 requests per minute');
      error.code = 'WEB_SEARCH_RATE_LIMITED';
      throw error;
    }
    this.requestTimes.push(now);
  }
}

function validateQuery(query, signal) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query))
    throw new TypeError(`query must contain 1-${MAX_QUERY_LENGTH} printable characters`);
  if (signal?.aborted) throw signal.reason || new Error('Web search was cancelled');
}

function missingSearchCredential(cause) {
  const error = new Error('Brave Search credential is unavailable; use the keyless search fallback', { cause });
  error.code = 'WEB_SEARCH_CREDENTIAL_MISSING';
  return error;
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function safeResultUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) return null;
    return url.href;
  } catch {
    return null;
  }
}

function canonicalResultUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return null;
  }
}

function cleanText(value, maxLength) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function parseGoogleNewsRss(xml, maxResults) {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return items.slice(0, maxResults).flatMap((item) => {
    const title = xmlTag(item, 'title');
    const url = safeResultUrl(xmlTag(item, 'link'));
    const source = xmlTag(item, 'source');
    const published = xmlTag(item, 'pubDate');
    const date = published ? new Date(published) : null;
    if (!title || !url || (date && !Number.isFinite(date.getTime()))) return [];
    const snippet = [source, date && `Published ${date.toISOString()}`].filter(Boolean).join(' · ');
    return [{ title: cleanText(title, 300), url, snippet: cleanText(snippet, MAX_RESULT_TEXT) }];
  });
}

function xmlTag(xml, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedName}>`, 'i'));
  return match ? decodeXml(stripHtml(match[1])) : '';
}

function decodeXml(value) {
  return value.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_entity, numeric, named) => {
    if (numeric) {
      const point = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()] || ' ';
  });
}

function enforceRequestRate(provider, label, now) {
  provider.requestTimes = provider.requestTimes.filter((time) => now - time < 60_000);
  if (provider.requestTimes.length >= 10) {
    const error = new Error(`${label} is limited to 10 requests per minute`);
    error.code = 'WEB_SEARCH_RATE_LIMITED';
    throw error;
  }
  provider.requestTimes.push(now);
}

async function readTextLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error('Web search response exceeded the 1 MiB response limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Web search response exceeded the 1 MiB response limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

async function readJsonLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error('Web search response exceeded the 2 MiB response limit');
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Web search response exceeded the 2 MiB response limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new Error('Web search returned malformed JSON');
  }
}
