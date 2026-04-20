import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 15_000;
const LANGUAGE_RE = /^[a-z]{2,3}$/;

const inputSchema = {
  term: z
    .string()
    .min(1)
    .max(200)
    .describe('The word or phrase to look up. Passed to Wiktionary verbatim (after URL-encoding).'),
  language_code: z
    .string()
    .regex(LANGUAGE_RE)
    .optional()
    .describe(
      'Optional ISO 639 language code (e.g. "en", "sv", "de") to filter the response. If omitted, all languages documented on the English Wiktionary page are returned.',
    ),
};

const senseSchema = z.object({
  definition: z.string(),
  examples: z.array(z.string()),
});

const posSchema = z.object({
  part_of_speech: z.string(),
  senses: z.array(senseSchema),
});

const langEntrySchema = z.object({
  language_code: z.string(),
  language_name: z.string(),
  parts_of_speech: z.array(posSchema),
});

const outputSchema = {
  term: z.string().describe('Echo of the requested term.'),
  languages: z.array(langEntrySchema).describe('Definitions grouped by source language.'),
};

interface RawSense {
  readonly definition?: string;
  readonly examples?: readonly string[];
  readonly parsedExamples?: readonly { readonly example?: string }[];
}

interface RawPos {
  readonly partOfSpeech?: string;
  readonly language?: string;
  readonly definitions?: readonly RawSense[];
}

type RawResponse = Record<string, readonly RawPos[]>;

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'dictionary',
  title: 'Dictionary',
  description:
    'Look up a word on the English Wiktionary via its REST v1 definition endpoint. Returns part-of-speech groupings and sense definitions with example sentences, grouped by source language (e.g. English, Swedish, German). HTML markup from the response is stripped before returning. Optionally filter to a single source language via language_code. Returns isError for unknown words (HTTP 404) and throws TransientError on upstream 5xx.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 60 },

  handler: async ({ term, language_code }, ctx: ToolContext): Promise<CallToolResult> => {
    const encoded = encodeURIComponent(term);
    const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encoded}?redirect=true`;

    let response: Response;
    try {
      response = await fetchExternal(url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      throw new TransientError(
        `Wiktionary request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Wiktionary is temporarily unavailable. Please try again.',
      );
    }

    if (response.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text: `No Wiktionary entry for "${term}".`,
          },
        ],
        isError: true,
      };
    }

    if (!response.ok) {
      throw new TransientError(
        `Wiktionary returned HTTP ${response.status}`,
        'Wiktionary is temporarily unavailable. Please try again.',
      );
    }

    const data = (await response.json()) as RawResponse;
    const languages = normalizeLanguages(data, language_code);

    if (languages.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: language_code
              ? `Wiktionary has an entry for "${term}" but no definitions in language "${language_code}".`
              : `Wiktionary returned no definitions for "${term}".`,
          },
        ],
        isError: true,
        structuredContent: { term, languages: [] },
      };
    }

    const text = formatText(term, languages);

    return {
      content: [{ type: 'text', text }],
      structuredContent: { term, languages },
    };
  },
};

export default tool;

interface Sense {
  readonly definition: string;
  readonly examples: readonly string[];
}

interface Pos {
  readonly part_of_speech: string;
  readonly senses: readonly Sense[];
}

interface LanguageEntry {
  readonly language_code: string;
  readonly language_name: string;
  readonly parts_of_speech: readonly Pos[];
}

function normalizeLanguages(data: RawResponse, languageCode: string | undefined): LanguageEntry[] {
  const out: LanguageEntry[] = [];
  for (const [code, posArr] of Object.entries(data)) {
    if (!Array.isArray(posArr)) continue;
    if (languageCode !== undefined && code.toLowerCase() !== languageCode.toLowerCase()) continue;

    const posList: Pos[] = [];
    let languageName = code;
    for (const pos of posArr) {
      if (typeof pos.language === 'string' && pos.language.length > 0) {
        languageName = pos.language;
      }
      const senses: Sense[] = [];
      for (const raw of pos.definitions ?? []) {
        const definition = clean(raw.definition ?? '');
        if (!definition) continue;
        const examples: string[] = [];
        for (const ex of raw.examples ?? []) {
          const cleaned = clean(ex);
          if (cleaned) examples.push(cleaned);
        }
        if (examples.length === 0) {
          for (const pex of raw.parsedExamples ?? []) {
            const cleaned = clean(pex.example ?? '');
            if (cleaned) examples.push(cleaned);
          }
        }
        senses.push({ definition, examples });
      }
      if (senses.length === 0) continue;
      posList.push({ part_of_speech: pos.partOfSpeech ?? '(unknown)', senses });
    }
    if (posList.length === 0) continue;
    out.push({ language_code: code, language_name: languageName, parts_of_speech: posList });
  }
  return out;
}

function clean(html: string): string {
  if (!html) return '';
  return decodeHtmlEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

// Iterate to a fixed point so crafted input like `<scr<script>ipt>` cannot
// leave a tag behind after a single pass.
function stripTags(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, '');
  } while (s !== prev);
  return s;
}

// Single-pass decode: chained sequential `.replace()` calls can double-decode
// (e.g. `&amp;lt;` → `&lt;` → `<`), so match every recognised entity in one
// regex and resolve each match independently.
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|nbsp|amp|lt|gt|quot);/g, (_, e: string) => {
    if (e.charCodeAt(0) === 35 /* '#' */) {
      return e.charCodeAt(1) === 120 /* 'x' */
        ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
        : String.fromCodePoint(Number(e.slice(1)));
    }
    switch (e) {
      case 'nbsp':
        return ' ';
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      default:
        return `&${e};`;
    }
  });
}

function formatText(term: string, languages: readonly LanguageEntry[]): string {
  const lines: string[] = [`# ${term}`];
  for (const lang of languages) {
    lines.push('');
    lines.push(`## ${lang.language_name} (${lang.language_code})`);
    for (const pos of lang.parts_of_speech) {
      lines.push('');
      lines.push(`### ${pos.part_of_speech}`);
      let senseIdx = 0;
      for (const s of pos.senses) {
        senseIdx++;
        lines.push(`${senseIdx}. ${s.definition}`);
        for (const ex of s.examples) {
          lines.push(`   — ${ex}`);
        }
      }
    }
  }
  return lines.join('\n');
}
