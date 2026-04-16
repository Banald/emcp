import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFeed } from './feed.ts';

describe('parseFeed', () => {
  describe('RSS 2.0', () => {
    it('parses title, link, description, and pubDate for every item', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example</title>
    <link>https://example.com/</link>
    <description>News</description>
    <item>
      <title>First headline</title>
      <link>https://example.com/a</link>
      <description>Short summary of A.</description>
      <pubDate>Wed, 02 Oct 2024 15:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second headline</title>
      <link>https://example.com/b</link>
      <description>Short summary of B.</description>
      <pubDate>Wed, 02 Oct 2024 16:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 2);
      assert.equal(items[0]?.title, 'First headline');
      assert.equal(items[0]?.link, 'https://example.com/a');
      assert.equal(items[0]?.description, 'Short summary of A.');
      assert.ok(items[0]?.publishedAt instanceof Date);
      assert.equal(items[0]?.publishedAt?.toISOString(), '2024-10-02T15:00:00.000Z');

      assert.equal(items[1]?.title, 'Second headline');
      assert.equal(items[1]?.link, 'https://example.com/b');
    });

    it('drops items missing a title', () => {
      const xml = `<rss><channel>
        <item><link>https://example.com/a</link></item>
        <item><title>Keep me</title><link>https://example.com/b</link></item>
      </channel></rss>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 1);
      assert.equal(items[0]?.title, 'Keep me');
    });

    it('drops items missing a link', () => {
      const xml = `<rss><channel>
        <item><title>No link</title></item>
        <item><title>With link</title><link>https://example.com/b</link></item>
      </channel></rss>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 1);
      assert.equal(items[0]?.title, 'With link');
    });

    it('decodes CDATA-wrapped descriptions', () => {
      const xml = `<rss><channel>
        <item>
          <title>T</title>
          <link>https://example.com/a</link>
          <description><![CDATA[<p>Rich <em>content</em> & symbols.</p>]]></description>
        </item>
      </channel></rss>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 1);
      assert.match(items[0]?.description ?? '', /Rich/);
      assert.match(items[0]?.description ?? '', /content/);
    });

    it('omits publishedAt when pubDate is absent', () => {
      const xml = `<rss><channel>
        <item><title>T</title><link>https://example.com/a</link></item>
      </channel></rss>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 1);
      assert.equal(items[0]?.publishedAt, undefined);
    });

    it('omits publishedAt when pubDate is unparseable', () => {
      const xml = `<rss><channel>
        <item>
          <title>T</title>
          <link>https://example.com/a</link>
          <pubDate>not a real date</pubDate>
        </item>
      </channel></rss>`;

      const items = parseFeed(xml);

      assert.equal(items[0]?.publishedAt, undefined);
    });

    it('omits description when absent or whitespace-only', () => {
      const xml = `<rss><channel>
        <item>
          <title>T</title>
          <link>https://example.com/a</link>
          <description>   </description>
        </item>
      </channel></rss>`;

      const items = parseFeed(xml);

      assert.equal(items[0]?.description, undefined);
    });
  });

  describe('Atom 1.0', () => {
    it('parses title, link href, summary, and published', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title>First</title>
    <link rel="alternate" href="https://example.com/one" />
    <summary>First summary</summary>
    <published>2024-10-02T15:00:00Z</published>
  </entry>
  <entry>
    <title>Second</title>
    <link rel="alternate" href="https://example.com/two" />
    <content>Full body</content>
    <updated>2024-10-02T16:00:00Z</updated>
  </entry>
</feed>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 2);
      assert.equal(items[0]?.title, 'First');
      assert.equal(items[0]?.link, 'https://example.com/one');
      assert.equal(items[0]?.description, 'First summary');
      assert.equal(items[0]?.publishedAt?.toISOString(), '2024-10-02T15:00:00.000Z');
      assert.equal(items[1]?.description, 'Full body');
      assert.equal(items[1]?.publishedAt?.toISOString(), '2024-10-02T16:00:00.000Z');
    });

    it('prefers rel="alternate" when multiple <link> tags are present', () => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>T</title>
          <link rel="self" href="https://example.com/feed" />
          <link rel="alternate" href="https://example.com/page" />
        </entry>
      </feed>`;

      const items = parseFeed(xml);

      assert.equal(items[0]?.link, 'https://example.com/page');
    });

    it('falls back to the first <link> when no rel="alternate" is present', () => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>T</title>
          <link rel="enclosure" href="https://example.com/pic.jpg" />
          <link rel="related" href="https://example.com/related" />
        </entry>
      </feed>`;

      const items = parseFeed(xml);

      assert.equal(items[0]?.link, 'https://example.com/pic.jpg');
    });

    it('drops entries missing link href', () => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
        <entry><title>No link</title></entry>
        <entry>
          <title>Linked</title>
          <link rel="alternate" href="https://example.com/ok" />
        </entry>
      </feed>`;

      const items = parseFeed(xml);

      assert.equal(items.length, 1);
      assert.equal(items[0]?.title, 'Linked');
    });
  });

  describe('error handling', () => {
    it('returns an empty array on empty input', () => {
      assert.deepEqual(parseFeed(''), []);
    });

    it('returns an empty array on whitespace input', () => {
      assert.deepEqual(parseFeed('   '), []);
    });

    it('returns an empty array when the XML has no items or entries', () => {
      const xml = `<rss><channel><title>No items</title></channel></rss>`;
      assert.deepEqual(parseFeed(xml), []);
    });

    it('returns an empty array on unrecognized root element', () => {
      const xml = `<other><thing>x</thing></other>`;
      assert.deepEqual(parseFeed(xml), []);
    });
  });
});
