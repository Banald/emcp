import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './fetch-url.ts';

const makeCtx = (overrides: Record<string, unknown> = {}): ToolContext =>
  ({
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
    apiKey: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      prefix: 'mcp_test_abc',
      name: 'test key',
      rateLimitPerMinute: 60,
    },
    requestId: 'req-00000000-0000-0000-0000-000000000001',
    signal: AbortSignal.timeout(25_000),
    ...overrides,
  }) as unknown as ToolContext;

const htmlResponse = (
  body: string,
  status = 200,
  contentType = 'text/html; charset=utf-8',
): Response => new Response(body, { status, headers: { 'Content-Type': contentType } });

const textResponse = (
  body: string,
  status = 200,
  contentType = 'text/plain; charset=utf-8',
): Response => new Response(body, { status, headers: { 'Content-Type': contentType } });

const redirectResponse = (location: string | null, status = 301): Response => {
  const headers = new Headers();
  if (location !== null) headers.set('Location', location);
  return new Response(null, { status, headers });
};

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

// Queue-based fetch mock so redirect chains can return different responses per call.
const queueFetch = (
  responses: Array<Response | (() => Response) | (() => Promise<Response>)>,
): void => {
  let i = 0;
  mock.method(globalThis, 'fetch', async () => {
    const entry = responses[i++];
    if (entry === undefined)
      throw new Error(`fetch called ${i} times but only ${responses.length} responses queued`);
    return typeof entry === 'function' ? entry() : entry;
  });
};

describe('fetch-url tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'fetch-url');
      assert.equal(tool.title, 'Fetch URL');
    });

    it('has a non-empty description mentioning Readability and Markdown', () => {
      assert.ok(tool.description.length > 0);
      assert.match(tool.description, /Readability/);
      assert.match(tool.description, /Markdown/);
    });

    it('has rate limit set to 30/min', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 30 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a valid https URL with defaults', () => {
      const result = schema.safeParse({ url: 'https://example.com/' });
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.data.max_length, 50_000);
    });

    it('accepts a valid http URL', () => {
      const result = schema.safeParse({ url: 'http://example.com/' });
      assert.equal(result.success, true);
    });

    it('rejects a non-URL string', () => {
      const result = schema.safeParse({ url: 'not a url' });
      assert.equal(result.success, false);
    });

    it('rejects an empty URL', () => {
      const result = schema.safeParse({ url: '' });
      assert.equal(result.success, false);
    });

    it('rejects URLs longer than 2048 chars', () => {
      const result = schema.safeParse({ url: `https://example.com/${'a'.repeat(2050)}` });
      assert.equal(result.success, false);
    });

    it('rejects missing url', () => {
      const result = schema.safeParse({});
      assert.equal(result.success, false);
    });

    it('rejects max_length below 500', () => {
      const result = schema.safeParse({ url: 'https://example.com/', max_length: 100 });
      assert.equal(result.success, false);
    });

    it('rejects max_length above 100000', () => {
      const result = schema.safeParse({ url: 'https://example.com/', max_length: 200_000 });
      assert.equal(result.success, false);
    });

    it('rejects non-integer max_length', () => {
      const result = schema.safeParse({ url: 'https://example.com/', max_length: 1000.5 });
      assert.equal(result.success, false);
    });
  });

  describe('HTML extraction with Readability', () => {
    it('extracts title, byline, and article body as Markdown', async () => {
      const html = `<!doctype html>
<html>
  <head>
    <title>The Real Article</title>
    <meta name="author" content="Jane Doe">
  </head>
  <body>
    <nav>home | about | contact | shop | newsletter</nav>
    <header>site chrome that should be removed</header>
    <main>
      <article>
        <h1>The Real Article</h1>
        <p class="byline">By Jane Doe</p>
        <p>This is a substantive paragraph with enough text that Readability will be confident this is the article body. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
        <p>A second paragraph also adding meaningful length to the article body. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
        <p>A third paragraph because Readability wants a content-heavy page. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>
        <p>A <a href="/other">relative link</a> that should be resolved against the base.</p>
      </article>
    </main>
    <footer>footer that should be removed</footer>
  </body>
</html>`;
      queueFetch([htmlResponse(html)]);

      const result = await tool.handler(
        { url: 'https://example.com/article', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      const text = textOf(result);
      assert.match(text, /URL: https:\/\/example\.com\/article/);
      assert.match(text, /Status: 200/);
      assert.match(text, /Title: The Real Article/);
      assert.match(text, /Byline: Jane Doe/);
      // Paragraph content is preserved in Markdown (no HTML tags)
      assert.match(text, /substantive paragraph/);
      assert.doesNotMatch(text, /<p>/);
      assert.doesNotMatch(text, /<article>/);
      // Links are inlined, and relative -> absolute via the injected <base>
      assert.match(text, /\[relative link\]\(https:\/\/example\.com\/other\)/);
      // Chrome elements are stripped
      assert.doesNotMatch(text, /home \| about \| contact/);
      assert.doesNotMatch(text, /footer that should be removed/);
    });

    it('drops scripts and styles', async () => {
      const html = `<!doctype html><html><head><title>T</title><style>.a{color:red}</style></head>
<body><article><h1>Headline</h1>
<script>alert('pwnd')</script>
<p>${'Meaningful content. '.repeat(30)}</p>
</article></body></html>`;
      queueFetch([htmlResponse(html)]);

      const result = await tool.handler(
        { url: 'https://example.com/x', max_length: 50_000 },
        makeCtx(),
      );

      const text = textOf(result);
      assert.doesNotMatch(text, /alert\('pwnd'\)/);
      assert.doesNotMatch(text, /color:red/);
      assert.match(text, /Meaningful content/);
    });

    it('falls back to whole-page Markdown when Readability finds nothing', async () => {
      // Empty body -> Readability has nothing to extract -> fallback path.
      const html = `<!doctype html><html><head><title>Empty Page</title></head><body></body></html>`;
      queueFetch([htmlResponse(html)]);

      const result = await tool.handler(
        { url: 'https://example.com/empty', max_length: 50_000 },
        makeCtx(),
      );

      const text = textOf(result);
      assert.match(text, /Title: Empty Page/);
      assert.match(text, /Readability did not find article content/);
    });

    it('handles HTML without a <head> tag by synthesizing one', async () => {
      const html = `<html><body><article>${'<p>Body only content. </p>'.repeat(30)}</article></body></html>`;
      queueFetch([htmlResponse(html)]);

      const result = await tool.handler(
        { url: 'https://example.com/headless', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /Body only content/);
    });

    it('handles a bare HTML fragment', async () => {
      const html = `${'<p>Just a fragment with some text. </p>'.repeat(30)}`;
      queueFetch([htmlResponse(html)]);

      const result = await tool.handler(
        { url: 'https://example.com/frag', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /Just a fragment/);
    });

    it('handles application/xhtml+xml as HTML', async () => {
      const html = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title></head><body><article><h1>Hi</h1>${'<p>Content paragraph. </p>'.repeat(30)}</article></body></html>`;
      queueFetch([htmlResponse(html, 200, 'application/xhtml+xml')]);

      const result = await tool.handler(
        { url: 'https://example.com/xhtml', max_length: 50_000 },
        makeCtx(),
      );

      const text = textOf(result);
      assert.match(text, /Content paragraph/);
    });
  });

  describe('non-HTML text content', () => {
    it('returns JSON verbatim', async () => {
      const payload = JSON.stringify({ hello: 'world', n: 42 });
      queueFetch([textResponse(payload, 200, 'application/json; charset=utf-8')]);

      const result = await tool.handler(
        { url: 'https://example.com/api', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      const text = textOf(result);
      assert.match(text, /Content-Type: application\/json/);
      assert.match(text, /"hello":"world"/);
    });

    it('returns plain text verbatim', async () => {
      queueFetch([textResponse('hello\nworld\n')]);

      const result = await tool.handler(
        { url: 'https://example.com/readme.txt', max_length: 50_000 },
        makeCtx(),
      );

      const text = textOf(result);
      assert.match(text, /hello\nworld/);
    });

    it('returns XML verbatim', async () => {
      queueFetch([
        textResponse('<?xml version="1.0"?><root><item>x</item></root>', 200, 'application/xml'),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/feed.xml', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /<root><item>x<\/item><\/root>/);
    });

    it('recognizes +json subtypes as text', async () => {
      queueFetch([textResponse('{"ok":true}', 200, 'application/hal+json')]);

      const result = await tool.handler(
        { url: 'https://example.com/h', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /"ok":true/);
    });
  });

  describe('binary / non-text content', () => {
    it('does not attempt to extract binary content', async () => {
      queueFetch([
        new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/pic.jpg', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      const text = textOf(result);
      assert.match(text, /Content-Type: image\/jpeg/);
      assert.match(text, /non-text media type/);
    });

    it('treats missing Content-Type as binary', async () => {
      // A Uint8Array body does not cause Response to auto-set a Content-Type.
      queueFetch([new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200 })]);

      const result = await tool.handler(
        { url: 'https://example.com/unknown', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /Content-Type: \(none\)/);
      assert.match(textOf(result), /non-text media type/);
    });
  });

  describe('non-2xx responses', () => {
    it('returns isError with a snippet for 404', async () => {
      queueFetch([textResponse('Page not found', 404)]);

      const result = await tool.handler(
        { url: 'https://example.com/missing', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.match(text, /Status: 404/);
      assert.match(text, /non-2xx status/);
      assert.match(text, /Page not found/);
    });

    it('returns isError for 500 without crashing', async () => {
      queueFetch([textResponse('oops', 500)]);

      const result = await tool.handler(
        { url: 'https://example.com/boom', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /Status: 500/);
    });

    it('omits body snippet on binary error responses', async () => {
      queueFetch([
        new Response(Buffer.from([0x00, 0x01]), {
          status: 418,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/teapot', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.doesNotMatch(textOf(result), /Response body/);
    });
  });

  describe('redirects', () => {
    it('follows a 301 redirect', async () => {
      queueFetch([
        redirectResponse('https://example.com/dest', 301),
        htmlResponse(
          `<html><head><title>Dest</title></head><body><article><h1>Dest</h1>${'<p>x. </p>'.repeat(40)}</article></body></html>`,
        ),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/src', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      const text = textOf(result);
      assert.match(text, /URL: https:\/\/example\.com\/dest/);
      assert.match(text, /Title: Dest/);
    });

    it('resolves relative Location headers', async () => {
      queueFetch([
        redirectResponse('/other', 302),
        htmlResponse(
          `<html><head><title>Other</title></head><body><article><h1>Other</h1>${'<p>y. </p>'.repeat(40)}</article></body></html>`,
        ),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/a', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /URL: https:\/\/example\.com\/other/);
    });

    it('returns isError when redirect has no Location header', async () => {
      queueFetch([redirectResponse(null, 302)]);

      const result = await tool.handler(
        { url: 'https://example.com/s', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /redirect 302 with no Location/);
    });

    it('returns isError on too many redirects', async () => {
      queueFetch([
        redirectResponse('https://example.com/1', 302),
        redirectResponse('https://example.com/2', 302),
        redirectResponse('https://example.com/3', 302),
        redirectResponse('https://example.com/4', 302),
        redirectResponse('https://example.com/5', 302),
        redirectResponse('https://example.com/6', 302),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /too many redirects/);
    });

    it('returns isError when redirect Location is malformed', async () => {
      queueFetch([redirectResponse('http://[::bad]:::1/', 302)]);

      const result = await tool.handler(
        { url: 'https://example.com/s', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /invalid Location/);
    });

    it('returns isError when a redirect points to a non-http(s) protocol', async () => {
      queueFetch([redirectResponse('file:///etc/passwd', 302)]);

      const result = await tool.handler(
        { url: 'https://example.com/s', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /unsupported protocol "file:"/);
    });

    it('does not treat 304 Not Modified as a redirect', async () => {
      queueFetch([new Response(null, { status: 304, headers: {} })]);

      const result = await tool.handler(
        { url: 'https://example.com/', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /Status: 304/);
    });
  });

  describe('failure modes always return isError and never throw', () => {
    it('returns isError on a generic network failure', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed');
      });

      const result = await tool.handler(
        { url: 'https://example.com/', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /network error: fetch failed/);
    });

    it('returns isError on a TimeoutError from AbortSignal', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      });

      const result = await tool.handler(
        { url: 'https://example.com/', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /timed out after/);
    });

    it('returns isError on an AbortError', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new DOMException('aborted', 'AbortError');
      });

      const result = await tool.handler(
        { url: 'https://example.com/', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /request aborted/);
    });

    it('returns isError for a hostname that resolves to a private address (SSRF)', async () => {
      // localhost resolves to 127.0.0.1 / ::1 — assertPublicHostname rejects it.
      const result = await tool.handler(
        { url: 'http://localhost/secret', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, true);
      assert.match(textOf(result), /non-public address/);
    });

    it('logs a warning on failure', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('boom');
      });
      const ctx = makeCtx();

      await tool.handler({ url: 'https://example.com/', max_length: 50_000 }, ctx);

      const warn = ctx.logger.warn as unknown as ReturnType<typeof mock.fn>;
      assert.equal(warn.mock.callCount(), 1);
    });
  });

  describe('truncation', () => {
    it('truncates extracted text to max_length and adds a note', async () => {
      const longPara = 'x'.repeat(10_000);
      const html = `<html><head><title>Long</title></head><body><article><h1>H</h1><p>${longPara}</p></article></body></html>`;
      queueFetch([htmlResponse(html)]);

      const result = await tool.handler(
        { url: 'https://example.com/', max_length: 500 },
        makeCtx(),
      );

      const text = textOf(result);
      assert.match(text, /content truncated to 500/);
    });

    it('flags wire-level truncation when the body is larger than 2MB', async () => {
      // Create a 3MB HTML blob via a ReadableStream so readCappedBody hits its cap.
      const encoder = new TextEncoder();
      const chunk = encoder.encode(`<p>${'x'.repeat(65_536)}</p>`);
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 48; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      queueFetch([
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/big', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /wire-truncated/);
    });

    it('handles an empty response body', async () => {
      queueFetch([new Response(null, { status: 200, headers: { 'Content-Type': 'text/plain' } })]);

      const result = await tool.handler(
        { url: 'https://example.com/empty', max_length: 50_000 },
        makeCtx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /Bytes: 0/);
    });
  });

  describe('Content-Type parsing', () => {
    it('respects charset in Content-Type', async () => {
      // ISO-8859-1 'é' is 0xE9.
      const body = Buffer.from([0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9]); // 'résumé'
      queueFetch([
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=iso-8859-1' },
        }),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/r.txt', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /résumé/);
    });

    it('tolerates a quoted charset parameter', async () => {
      queueFetch([
        new Response('hello', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset="utf-8"' },
        }),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/q', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /hello/);
    });

    it('falls back to utf-8 when the declared charset is unknown', async () => {
      queueFetch([
        new Response('fallback', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=x-nonsense' },
        }),
      ]);

      const result = await tool.handler(
        { url: 'https://example.com/x', max_length: 50_000 },
        makeCtx(),
      );

      assert.match(textOf(result), /fallback/);
    });
  });

  describe('logging', () => {
    it('logs query details on invocation', async () => {
      queueFetch([textResponse('ok')]);
      const ctx = makeCtx();

      await tool.handler({ url: 'https://example.com/', max_length: 50_000 }, ctx);

      const info = ctx.logger.info as unknown as ReturnType<typeof mock.fn>;
      assert.equal(info.mock.callCount(), 1);
      const arg = info.mock.calls[0].arguments[0] as Record<string, unknown>;
      assert.equal(arg.url, 'https://example.com/');
      assert.equal(arg.max_length, 50_000);
    });
  });
});
