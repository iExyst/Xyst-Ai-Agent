import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomaticWebSearchProvider,
  BraveWebSearchProvider,
  DuckDuckGoWebSearchProvider,
  GdeltWebSearchProvider,
  GoogleNewsRssProvider,
  KeylessFallbackWebSearchProvider,
  WikipediaWebSearchProvider,
  WebPageProvider,
} from '../src/providers/web-search.mjs';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { TOOL_DEFINITIONS, validateArguments } from '../src/tools/schemas.mjs';

const webConfig = { enabled: true, provider: 'brave', api_key_env: 'BRAVE_TEST_KEY', max_results: 2, timeout_ms: 2000 };

test('source reader follows bounded HTTPS redirects and extracts page text and structured data', async () => {
  const visited = [];
  const provider = new WebPageProvider({
    fetchImpl: async (url, options) => {
      visited.push(url);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.authorization, undefined);
      if (visited.length === 1) return new Response(null, { status: 302, headers: { location: '/source' } });
      return new Response(
        '<title>Official &amp; current</title><style>hide</style><script>doEvil()</script><main>Verified <b>facts</b>.</main>',
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  const page = await provider.read('https://example.com/start');
  assert.deepEqual(visited, ['https://example.com/start', 'https://example.com/source']);
  assert.equal(page.title, 'Official & current');
  assert.match(page.content, /Verified facts/);
  assert.doesNotMatch(page.content, /doEvil|hide/);
  assert.equal(page.truncated, false);
  assert.ok(Number.isFinite(Date.parse(page.fetched_at)));
  const json = new WebPageProvider({ fetchImpl: async () => Response.json({ temperature: 12 }) });
  assert.match((await json.read('https://example.com/api')).content, /"temperature":12/);
  assert.equal(TOOL_DEFINITIONS.web_fetch.approval, 'ask');
  assert.throws(() => validateArguments(TOOL_DEFINITIONS.web_fetch.parameters, '{}'), /url is required/);
});

test('source reader rejects unsafe redirects, unsupported formats and oversized responses', async () => {
  const redirect = new WebPageProvider({
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://example.com/' } }),
  });
  await assert.rejects(redirect.read('https://example.com/'), /unsupported redirect/);
  await assert.rejects(redirect.read('https://user:pass@example.com/'), /without embedded credentials/);
  await assert.rejects(redirect.read('file:///etc/passwd'), /HTTPS/);
  const loop = new WebPageProvider({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
  await assert.rejects(loop.read('https://example.com/'), /unsupported redirect/);
  const binary = new WebPageProvider({ fetchImpl: async () => new Response('binary', { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(binary.read('https://example.com/'), /different reader/);
  const large = new WebPageProvider({
    fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'text/plain' } }),
  });
  await assert.rejects(large.read('https://example.com/'), /response limit/);
});

test('general web search returns source links and snippets without a key and bounds untrusted results', async () => {
  let calls = 0;
  const provider = new DuckDuckGoWebSearchProvider({
    config: { max_results: 2 },
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(new URL(url).searchParams.get('q'), 'official documentation');
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.redirect, 'error');
      return new Response(`<html>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdocs&amp;rut=x">Node.js &amp; docs</a>
      <a class="result__snippet">Read the <b>official</b> documentation.</a>
      <a class="result__a" href="javascript:alert(1)">Unsafe</a>
      <a class="result__a" href="https://user:password@example.com/">Credential</a>
      <a class="result__a" href="https://nodejs.org/en/docs">Duplicate</a>
      <a class="result__a" href="https://example.org/">Second</a>
      <a class="result__a" href="https://example.net/">Over limit</a></html>`);
    },
  });
  const result = await provider.search('official documentation');
  assert.equal(calls, 1);
  assert.deepEqual(result.results, [
    { title: 'Node.js & docs', url: 'https://nodejs.org/en/docs', snippet: 'Read the official documentation.' },
    { title: 'Second', url: 'https://example.org/', snippet: '' },
  ]);
  await assert.rejects(provider.search(''), /query must contain/);
  const challenged = new DuckDuckGoWebSearchProvider({ fetchImpl: async () => new Response('<form id="challenge-form">Verify</form>') });
  await assert.rejects(challenged.search('test'), /browser verification/);
  const oversized = new DuckDuckGoWebSearchProvider({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(oversized.search('test'), /response limit/);
});

test('Brave adapter sends an approved query with a secret header and returns bounded safe result fields', async () => {
  let request;
  const results = [
    { title: 'Result one', url: 'https://example.com/1', description: 'Useful   summary' },
    { title: 'Result two', url: 'https://example.com/2', description: 'Second result' },
    { title: 'Discarded third', url: 'https://example.com/3', description: 'Over configured count' },
    { title: 'Unsafe scheme', url: 'javascript:alert(1)', description: 'Discard me' },
    { title: 'Credential URL', url: 'https://user:pass@example.com/', description: 'Discard me' },
  ];
  const provider = new BraveWebSearchProvider({
    config: webConfig,
    env: { BRAVE_TEST_KEY: 'test-brave-secret' },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json({ web: { results } });
    },
  });
  const output = await provider.search('  release notes  ');
  assert.equal(request.url.origin + request.url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(request.url.searchParams.get('q'), 'release notes');
  assert.equal(request.url.searchParams.get('count'), '2');
  assert.equal(request.options.headers['x-subscription-token'], 'test-brave-secret');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(output, {
    provider: 'brave',
    query: 'release notes',
    results: [
      { title: 'Result one', url: 'https://example.com/1', snippet: 'Useful summary' },
      { title: 'Result two', url: 'https://example.com/2', snippet: 'Second result' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(output), /test-brave-secret/);
});

test('web search rejects invalid queries, failed auth, oversized responses, and enforces a per-minute cap', async () => {
  const provider = new BraveWebSearchProvider({
    config: webConfig,
    env: { BRAVE_TEST_KEY: 'test-brave-secret' },
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(provider.search(''), /query must contain/);
  await assert.rejects(provider.search('x'.repeat(501)), /query must contain/);
  await assert.rejects(provider.search('line\nbreak'), /query must contain/);
  const authFailure = new BraveWebSearchProvider({
    config: webConfig,
    env: { BRAVE_TEST_KEY: 'test-brave-secret' },
    fetchImpl: async () => new Response('no', { status: 403 }),
  });
  await assert.rejects(authFailure.search('query'), /authentication failed/);
  const oversized = new BraveWebSearchProvider({
    config: webConfig,
    env: { BRAVE_TEST_KEY: 'test-brave-secret' },
    fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
  });
  await assert.rejects(oversized.search('query'), /2 MiB/);

  let now = 60_000;
  const limited = new BraveWebSearchProvider({
    config: webConfig,
    env: { BRAVE_TEST_KEY: 'test-brave-secret' },
    now: () => now,
    fetchImpl: async () => Response.json({ web: { results: [] } }),
  });
  for (let index = 0; index < 10; index += 1) await limited.search(`query ${index}`);
  await assert.rejects(limited.search('eleventh'), { code: 'WEB_SEARCH_RATE_LIMITED' });
  now += 60_001;
  assert.deepEqual((await limited.search('after window')).results, []);
});

test('web search is configuration-gated, schema bounded, and requires approval in assisted mode', async () => {
  const disabled = createBuiltinTools({ workspaceRoot: '.', config: {} });
  assert.equal(disabled.has('web_search'), false);
  const enabled = createBuiltinTools({
    workspaceRoot: '.',
    config: { web_search: { enabled: true } },
    webSearchProvider: { search: async (query) => ({ query }) },
  });
  assert.equal(enabled.has('web_search'), true);
  assert.equal(TOOL_DEFINITIONS.web_search.approval, 'ask');
  assert.deepEqual(validateArguments(TOOL_DEFINITIONS.web_search.parameters, '{"query":"docs"}'), { query: 'docs' });
  assert.throws(() => validateArguments(TOOL_DEFINITIONS.web_search.parameters, '{"query":""}'), /between 1 and 500/);
  assert.throws(
    () => validateArguments(TOOL_DEFINITIONS.web_search.parameters, JSON.stringify({ query: 'x'.repeat(501) })),
    /between 1 and 500/,
  );
  assert.match(await enabled.call('web_search', { query: 'docs' }, {}), /"query":"docs"/);
});

test('Wikipedia source performs a keyless live search and returns bounded, sanitized reference links', async () => {
  const requests = [];
  const provider = new WikipediaWebSearchProvider({
    config: { enabled: true, provider: 'wikipedia', max_results: 1 },
    fetchImpl: async (url, options) => {
      const request = { url: new URL(url), options };
      requests.push(request);
      if (request.url.searchParams.get('prop') === 'extracts')
        return Response.json({
          query: {
            pages: [
              { pageid: 42, extract: 'The Solar System is the gravitationally bound system of the Sun and the objects that orbit it.' },
            ],
          },
        });
      return Response.json({
        query: {
          search: [
            { pageid: 42, title: 'Solar System', snippet: 'The <span class="searchmatch">solar</span> &amp; planetary system.' },
            { pageid: 43, title: 'Discarded', snippet: 'Beyond configured result count.' },
          ],
        },
      });
    },
  });
  const output = await provider.search('solar system');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://en.wikipedia.org/w/api.php');
  assert.equal(requests[0].url.searchParams.get('action'), 'query');
  assert.equal(requests[0].url.searchParams.get('list'), 'search');
  assert.equal(requests[0].url.searchParams.get('srsearch'), 'solar system');
  assert.equal(requests[1].url.searchParams.get('prop'), 'extracts');
  assert.equal(requests[1].url.searchParams.get('pageids'), '42');
  assert.equal(
    requests.every((request) => request.options.redirect === 'error'),
    true,
  );
  assert.match(requests[0].options.headers['user-agent'], /Xyst-AI-Assistant/);
  assert.deepEqual(output, {
    provider: 'wikipedia',
    query: 'solar system',
    results: [
      {
        title: 'Solar System',
        url: 'https://en.wikipedia.org/?curid=42',
        snippet: 'The Solar System is the gravitationally bound system of the Sun and the objects that orbit it.',
      },
    ],
  });
  await assert.rejects(provider.search('bad\nquery'), /query must contain/);
});

test('Wikipedia source keeps its search snippet if page extract enrichment is unavailable', async () => {
  const provider = new WikipediaWebSearchProvider({
    config: { enabled: true, provider: 'wikipedia', max_results: 1 },
    fetchImpl: async (url) =>
      new URL(url).searchParams.get('prop') === 'extracts'
        ? new Response('unavailable', { status: 503 })
        : Response.json({ query: { search: [{ pageid: 19, title: 'Mercury', snippet: 'A planet in the Solar System.' }] } }),
  });
  const output = await provider.search('Mercury planet');
  assert.deepEqual(output.results, [
    { title: 'Mercury', url: 'https://en.wikipedia.org/?curid=19', snippet: 'A planet in the Solar System.' },
  ]);
});

test('GDELT provides bounded, sanitized live news results without credentials', async () => {
  let request;
  const provider = new GdeltWebSearchProvider({
    config: { enabled: true, max_results: 2 },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json({
        articles: [
          {
            title: '  Live   result ',
            url: 'https://news.example/story?id=1',
            domain: 'news.example',
            seendate: '20261027123456',
          },
          { title: 'Discarded', url: 'javascript:alert(1)' },
        ],
      });
    },
  });
  const output = await provider.search('current event');
  assert.equal(request.url.origin + request.url.pathname, 'https://api.gdeltproject.org/api/v2/doc/doc');
  assert.equal(request.url.searchParams.get('query'), 'current event');
  assert.equal(request.url.searchParams.get('mode'), 'artlist');
  assert.equal(request.url.searchParams.get('format'), 'json');
  assert.equal(request.url.searchParams.get('timespan'), '1week');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(output, {
    provider: 'gdelt',
    query: 'current event',
    results: [
      {
        title: 'Live result',
        url: 'https://news.example/story?id=1',
        snippet: 'news.example · Seen 2026-10-27 12:34 UTC',
      },
    ],
  });
});

test('GDELT briefly caches successful identical searches across provider instances without sharing mutable results', async () => {
  let now = 10_000;
  let requests = 0;
  const createProvider = () =>
    new GdeltWebSearchProvider({
      config: { enabled: true, max_results: 1 },
      now: () => now,
      fetchImpl: async () => {
        requests += 1;
        return Response.json({
          articles: [{ title: `Fresh ${requests}`, url: 'https://news.example/cache-check', domain: 'news.example' }],
        });
      },
    });

  const first = await createProvider().search('xyst cache behavior unique 20261027');
  first.results[0].title = 'caller mutation';
  const cached = await createProvider().search('Xyst cache behavior unique 20261027');
  assert.equal(requests, 1);
  assert.equal(cached.results[0].title, 'Fresh 1');

  now += 60_000;
  const refreshed = await createProvider().search('xyst cache behavior unique 20261027');
  assert.equal(requests, 2);
  assert.equal(refreshed.results[0].title, 'Fresh 2');
});

test('Google News RSS provides bounded keyless recent-news results with decoded titles and publication dates', async () => {
  let request;
  const provider = new GoogleNewsRssProvider({
    config: { max_results: 1 },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(
        '<?xml version="1.0"?><rss><channel><item><title>AI &amp; tools &#8212; Example News</title><link>https://news.google.com/rss/articles/example</link><pubDate>Tue, 27 Oct 2026 02:00:00 GMT</pubDate><source url="https://example.com">Example &amp; News</source></item><item><title>Discarded</title><link>https://news.example/2</link></item></channel></rss>',
        { headers: { 'content-type': 'application/rss+xml' } },
      );
    },
  });
  const output = await provider.search(' AI tools ');
  assert.equal(request.url.origin + request.url.pathname, 'https://news.google.com/rss/search');
  assert.equal(request.url.searchParams.get('q'), 'AI tools');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(output, {
    provider: 'google-news',
    query: 'AI tools',
    results: [
      {
        title: 'AI & tools — Example News',
        url: 'https://news.google.com/rss/articles/example',
        snippet: 'Example & News · Published 2026-10-27T02:00:00.000Z',
      },
    ],
  });
  await assert.rejects(provider.search('invalid\nquery'), /query must contain/);
});

test('automatic search combines live news and reference sources, deduplicates, and tolerates one source outage', async () => {
  const automatic = new AutomaticWebSearchProvider({
    maxResults: 4,
    news: { search: async () => ({ provider: 'gdelt', results: [{ title: 'News', url: 'https://news.example/' }] }) },
    reference: {
      search: async () => ({
        provider: 'wikipedia',
        results: [
          { title: 'Duplicate', url: 'https://news.example' },
          { title: 'Reference', url: 'https://en.wikipedia.org/wiki/Example' },
        ],
      }),
    },
  });
  assert.deepEqual(await automatic.search('example'), {
    provider: 'automatic',
    query: 'example',
    results: [
      { title: 'News', url: 'https://news.example/', source: 'gdelt' },
      { title: 'Reference', url: 'https://en.wikipedia.org/wiki/Example', source: 'wikipedia' },
    ],
    sources: ['gdelt', 'wikipedia'],
    unavailable_sources: [],
  });
  const partial = new AutomaticWebSearchProvider({
    news: {
      search: async () => {
        throw new Error('news temporarily unavailable');
      },
    },
    reference: {
      search: async () => ({ provider: 'wikipedia', results: [{ title: 'Reference', url: 'https://en.wikipedia.org/wiki/Example' }] }),
    },
  });
  const partialResult = await partial.search('example');
  assert.equal(partialResult.results[0].source, 'wikipedia');
  assert.deepEqual(partialResult.unavailable_sources, ['gdelt']);
});

test('automatic search keeps reachable live-news fallback results and names unavailable sources', async () => {
  const automatic = new AutomaticWebSearchProvider({
    news: [
      {
        sourceName: 'gdelt',
        search: async () => {
          throw new Error('upstream timeout');
        },
      },
      {
        sourceName: 'google-news',
        search: async () => ({ provider: 'google-news', results: [{ title: 'News', url: 'https://news.example/story' }] }),
      },
    ],
    reference: { sourceName: 'wikipedia', search: async () => ({ provider: 'wikipedia', results: [] }) },
  });
  const output = await automatic.search('latest news');
  assert.deepEqual(output.sources, ['google-news', 'wikipedia']);
  assert.deepEqual(output.unavailable_sources, ['gdelt']);
  assert.equal(output.results[0].source, 'google-news');
});

test('automatic search explains that total source outages are not an API-key problem', async () => {
  const automatic = new AutomaticWebSearchProvider({
    news: {
      sourceName: 'google-news',
      search: async () => {
        throw new Error('DNS lookup failed');
      },
    },
    reference: {
      sourceName: 'wikipedia',
      search: async () => {
        throw new Error('DNS lookup failed');
      },
    },
  });
  await assert.rejects(
    automatic.search('current news'),
    (error) =>
      error instanceof AggregateError &&
      /does not require an API key/.test(error.message) &&
      /internet connection or source availability/.test(error.message),
  );
});

test('Brave adapter supports the OS secret store without exposing the secret in its result', async () => {
  let keyName;
  const provider = new BraveWebSearchProvider({
    config: { enabled: true, provider: 'brave', api_key_secret: 'brave.search' },
    secretStore: {
      async get(name) {
        keyName = name;
        return 'vault-secret';
      },
    },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['x-subscription-token'], 'vault-secret');
      return Response.json({ web: { results: [] } });
    },
  });
  const output = await provider.search('safe query');
  assert.equal(keyName, 'brave.search');
  assert.doesNotMatch(JSON.stringify(output), /vault-secret/);
});

test('Brave search falls back to keyless Wikipedia when its optional credential is missing', async () => {
  let braveRequests = 0;
  let fallbackQuery;
  const provider = new KeylessFallbackWebSearchProvider({
    primary: new BraveWebSearchProvider({
      config: { enabled: true, provider: 'brave' },
      env: {},
      fetchImpl: async () => {
        braveRequests += 1;
        return Response.json({});
      },
    }),
    fallback: new WikipediaWebSearchProvider({
      config: { enabled: true, provider: 'brave' },
      fetchImpl: async (url) => {
        const request = new URL(url);
        if (request.searchParams.get('prop') === 'extracts')
          return Response.json({ query: { pages: [{ pageid: 42, extract: 'A planetary system.' }] } });
        fallbackQuery = request.searchParams.get('srsearch');
        return Response.json({ query: { search: [{ pageid: 42, title: 'Solar System', snippet: 'Reference result' }] } });
      },
    }),
  });

  const result = await provider.search('solar system');
  assert.equal(braveRequests, 0);
  assert.equal(fallbackQuery, 'solar system');
  assert.equal(result.provider, 'wikipedia');
  assert.equal(result.results[0].title, 'Solar System');

  const missingVaultCredential = new KeylessFallbackWebSearchProvider({
    primary: new BraveWebSearchProvider({
      config: { enabled: true, provider: 'brave', api_key_secret: 'brave.search' },
      secretStore: {
        async get() {
          throw new Error('Credential vault is unavailable');
        },
      },
    }),
    fallback: new WikipediaWebSearchProvider({
      config: { enabled: true },
      fetchImpl: async () => Response.json({ query: { search: [{ pageid: 43, title: 'Fallback result', snippet: 'Still available' }] } }),
    }),
  });
  assert.equal((await missingVaultCredential.search('another query')).results[0].title, 'Fallback result');
});

test('keyless fallback recovers from rejected Brave credentials', async () => {
  let fallbackRequests = 0;
  const provider = new KeylessFallbackWebSearchProvider({
    primary: new BraveWebSearchProvider({
      config: webConfig,
      env: { BRAVE_TEST_KEY: 'test-brave-secret' },
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    }),
    fallback: new WikipediaWebSearchProvider({
      config: { enabled: true },
      fetchImpl: async () => {
        fallbackRequests += 1;
        return Response.json({ query: { search: [] } });
      },
    }),
  });
  const result = await provider.search('query');
  assert.equal(result.provider, 'wikipedia');
  assert.equal(fallbackRequests, 1);
});

test('keyless fallback recovers from provider outages and rate limits without ignoring cancellation', async () => {
  for (const failure of [
    new TypeError('fetch failed'),
    Object.assign(new Error('busy'), { code: 'WEB_SEARCH_RATE_LIMITED' }),
    Object.assign(new Error('HTTP 503'), { code: 'WEB_SEARCH_FAILED' }),
  ]) {
    let fallbackCalls = 0;
    const controller = new AbortController();
    const provider = new KeylessFallbackWebSearchProvider({
      primary: {
        search: async () => {
          throw failure;
        },
      },
      fallback: {
        search: async () => {
          fallbackCalls += 1;
          return { results: [] };
        },
      },
    });
    assert.deepEqual(await provider.search('query'), { results: [] });
    controller.abort(new Error('user cancelled'));
    await assert.rejects(provider.search('query', { signal: controller.signal }), /user cancelled/);
    await assert.rejects(provider.search(''), /query must contain/);
    assert.equal(fallbackCalls, 1);
  }
});

test('automatic search keeps distinct case-sensitive paths and query values', async () => {
  const urls = ['https://example.com/Page', 'https://example.com/page', 'https://example.com/Page?key=A', 'https://example.com/Page?key=a'];
  const provider = new AutomaticWebSearchProvider({
    news: { search: async () => ({ provider: 'news', results: urls.map((url) => ({ title: url, url })) }) },
    reference: { search: async () => ({ provider: 'reference', results: [{ title: 'Duplicate fragment', url: `${urls[0]}#section` }] }) },
  });
  assert.deepEqual(
    (await provider.search('query')).results.map((entry) => entry.url),
    urls,
  );
});

test('Brave adapter checks cancellation after resolving a delayed vault credential', async () => {
  const controller = new AbortController();
  let requests = 0;
  const provider = new BraveWebSearchProvider({
    config: { enabled: true, provider: 'brave', api_key_secret: 'brave.search' },
    secretStore: {
      async get() {
        controller.abort(new Error('cancelled'));
        return 'secret';
      },
    },
    fetchImpl: async () => {
      requests += 1;
      return Response.json({});
    },
  });
  await assert.rejects(provider.search('query', { signal: controller.signal }), /cancelled/);
  assert.equal(requests, 0);
});
