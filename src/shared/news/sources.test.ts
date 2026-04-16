import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARTICLES_PER_SOURCE, NEWS_SOURCES } from './sources.ts';

describe('news sources registry', () => {
  it('contains exactly the three expected sources', () => {
    assert.equal(NEWS_SOURCES.length, 3);
    const keys = NEWS_SOURCES.map((s) => s.key).sort();
    assert.deepEqual(keys, ['aftonbladet', 'expressen', 'svt']);
  });

  it('every entry has a https RSS URL and a non-empty display name', () => {
    for (const source of NEWS_SOURCES) {
      assert.ok(source.name.length > 0, `${source.key} missing name`);
      const parsed = new URL(source.rssUrl);
      assert.equal(parsed.protocol, 'https:', `${source.key} must use https`);
      assert.ok(parsed.hostname.endsWith('.se'), `${source.key} must be on a .se host`);
    }
  });

  it('pins the exact RSS endpoints approved in the plan', () => {
    const byKey = Object.fromEntries(NEWS_SOURCES.map((s) => [s.key, s.rssUrl]));
    assert.equal(
      byKey.aftonbladet,
      'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/',
    );
    assert.equal(byKey.expressen, 'https://feeds.expressen.se/nyheter/');
    assert.equal(byKey.svt, 'https://www.svt.se/rss.xml');
  });

  it('exposes a per-source cap of 15', () => {
    assert.equal(ARTICLES_PER_SOURCE, 15);
  });

  it('is frozen to prevent runtime mutation', () => {
    assert.throws(() => {
      (NEWS_SOURCES as unknown as { push: (x: unknown) => number }).push({
        key: 'aftonbladet',
        name: 'x',
        rssUrl: 'https://x.se/',
      });
    });
  });
});
