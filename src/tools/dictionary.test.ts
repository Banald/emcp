import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './dictionary.ts';

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
    signal: new AbortController().signal,
    ...overrides,
  }) as unknown as ToolContext;

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const bankBody = {
  en: [
    {
      partOfSpeech: 'Noun',
      language: 'English',
      definitions: [
        {
          definition:
            'An <b>institution</b> where one can place and borrow money &amp; secure credit.',
          examples: ['I put my paycheck in the <b>bank</b> every Friday.'],
        },
        {
          definition: 'The edge of a river, lake, or other watercourse.',
        },
      ],
    },
    {
      partOfSpeech: 'Verb',
      language: 'English',
      definitions: [
        {
          definition: 'To tilt sideways when turning, as an aircraft does.',
          parsedExamples: [{ example: 'The plane <i>banked</i> sharply.' }],
        },
      ],
    },
  ],
  de: [
    {
      partOfSpeech: 'Noun',
      language: 'German',
      definitions: [
        { definition: 'bench (a long seat)' },
        { definition: 'bank (financial institution)' },
      ],
    },
  ],
  sv: [
    {
      partOfSpeech: 'Noun',
      language: 'Swedish',
      definitions: [{ definition: 'bank (financial institution)' }],
    },
  ],
};

describe('dictionary tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'dictionary');
      assert.equal(tool.title, 'Dictionary');
    });

    it('description mentions Wiktionary', () => {
      assert.match(tool.description, /Wiktionary/i);
    });

    it('has the documented rate limit', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 60 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a valid term alone', () => {
      assert.equal(schema.safeParse({ term: 'bank' }).success, true);
    });

    it('rejects an empty term', () => {
      assert.equal(schema.safeParse({ term: '' }).success, false);
    });

    it('rejects a term longer than 200 chars', () => {
      assert.equal(schema.safeParse({ term: 'a'.repeat(201) }).success, false);
    });

    it('accepts a valid 2-3 char language_code', () => {
      assert.equal(schema.safeParse({ term: 'bank', language_code: 'en' }).success, true);
      assert.equal(schema.safeParse({ term: 'bank', language_code: 'sv' }).success, true);
      assert.equal(schema.safeParse({ term: 'bank', language_code: 'sco' }).success, true);
    });

    it('rejects a 4-char or uppercase language_code', () => {
      assert.equal(schema.safeParse({ term: 'bank', language_code: 'engl' }).success, false);
      assert.equal(schema.safeParse({ term: 'bank', language_code: 'EN' }).success, false);
    });
  });

  describe('handler', () => {
    it('returns all languages when no filter is supplied', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank' }, ctx);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
        term: string;
        languages: Array<{ language_code: string; language_name: string }>;
      };
      assert.equal(structured.term, 'bank');
      assert.deepEqual(
        structured.languages.map((l) => l.language_code),
        ['en', 'de', 'sv'],
      );
      const en = structured.languages.find((l) => l.language_code === 'en');
      assert.equal(en?.language_name, 'English');
    });

    it('strips HTML tags and decodes entities in definitions and examples', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank', language_code: 'en' }, ctx);

      const structured = result.structuredContent as {
        languages: Array<{
          parts_of_speech: Array<{ senses: Array<{ definition: string; examples: string[] }> }>;
        }>;
      };
      const noun = structured.languages[0]?.parts_of_speech[0];
      assert.equal(
        noun?.senses[0]?.definition,
        'An institution where one can place and borrow money & secure credit.',
      );
      assert.equal(noun?.senses[0]?.examples[0], 'I put my paycheck in the bank every Friday.');
    });

    it('falls back to parsedExamples when examples is absent', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank', language_code: 'en' }, ctx);

      const structured = result.structuredContent as {
        languages: Array<{
          parts_of_speech: Array<{ part_of_speech: string; senses: Array<{ examples: string[] }> }>;
        }>;
      };
      const verb = structured.languages[0]?.parts_of_speech.find(
        (p) => p.part_of_speech === 'Verb',
      );
      assert.equal(verb?.senses[0]?.examples[0], 'The plane banked sharply.');
    });

    it('filters by language_code when supplied', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank', language_code: 'sv' }, ctx);

      const structured = result.structuredContent as {
        languages: Array<{ language_code: string }>;
      };
      assert.equal(structured.languages.length, 1);
      assert.equal(structured.languages[0]?.language_code, 'sv');
    });

    it('returns isError when language_code filter matches nothing', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank', language_code: 'zz' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no definitions in language "zz"/);
    });

    it('returns isError on HTTP 404 for unknown word', async () => {
      mock.method(
        globalThis,
        'fetch',
        async () => new Response('{"title":"Not found"}', { status: 404 }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'xyznonsenseword' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /No Wiktionary entry for "xyznonsenseword"/);
    });

    it('throws TransientError on HTTP 500', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ term: 'x' }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on network error', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('ECONNREFUSED');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ term: 'x' }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /ECONNREFUSED/);
          return true;
        },
      );
    });

    it('URL-encodes the term in the request path', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      await tool.handler({ term: 'über cool' }, ctx);
      const urlArg = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(urlArg, /\/definition\/%C3%BCber%20cool/);
    });

    it('renders the Markdown text block with language, POS, and senses', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank', language_code: 'en' }, ctx);
      const text = textOf(result);
      assert.match(text, /^# bank$/m);
      assert.match(text, /^## English \(en\)$/m);
      assert.match(text, /^### Noun$/m);
      assert.match(text, /^1\. An institution/m);
      assert.match(text, /— I put my paycheck/);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(bankBody));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'bank' }, ctx);
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('skips languages with only empty-definition entries', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: '' }] }],
          de: [
            {
              partOfSpeech: 'Noun',
              language: 'German',
              definitions: [{ definition: 'real definition' }],
            },
          ],
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'x' }, ctx);
      const structured = result.structuredContent as {
        languages: Array<{ language_code: string }>;
      };
      assert.deepEqual(
        structured.languages.map((l) => l.language_code),
        ['de'],
      );
    });

    it('returns isError when upstream returned non-language keys only', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse({}));
      const ctx = makeCtx();
      const result = await tool.handler({ term: 'x' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no definitions/i);
    });
  });
});
