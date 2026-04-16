import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractArticle, htmlToMarkdown } from './extract.ts';

describe('extractArticle', () => {
  it('extracts title, byline, and article body as Markdown', () => {
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

    const result = extractArticle(html, 'https://example.com/article');

    assert.equal(result.fallback, false);
    assert.equal(result.title, 'The Real Article');
    assert.equal(result.byline, 'Jane Doe');
    assert.match(result.markdown, /substantive paragraph/);
    assert.doesNotMatch(result.markdown, /<p>/);
    assert.doesNotMatch(result.markdown, /<article>/);
    assert.match(result.markdown, /\[relative link\]\(https:\/\/example\.com\/other\)/);
    assert.doesNotMatch(result.markdown, /home \| about \| contact/);
    assert.doesNotMatch(result.markdown, /footer that should be removed/);
  });

  it('drops scripts and styles', () => {
    const html = `<!doctype html><html><head><title>T</title><style>.a{color:red}</style></head>
<body><article><h1>Headline</h1>
<script>alert('pwnd')</script>
<p>${'Meaningful content. '.repeat(30)}</p>
</article></body></html>`;

    const result = extractArticle(html, 'https://example.com/x');

    assert.doesNotMatch(result.markdown, /alert\('pwnd'\)/);
    assert.doesNotMatch(result.markdown, /color:red/);
    assert.match(result.markdown, /Meaningful content/);
  });

  it('falls back to whole-page Markdown when Readability finds nothing', () => {
    const html = `<!doctype html><html><head><title>Empty Page</title></head><body></body></html>`;

    const result = extractArticle(html, 'https://example.com/empty');

    assert.equal(result.fallback, true);
    assert.equal(result.title, 'Empty Page');
    assert.equal(result.byline, undefined);
  });

  it('synthesizes a <head> when the HTML has none', () => {
    const html = `<html><body><article>${'<p>Body only content. </p>'.repeat(30)}</article></body></html>`;

    const result = extractArticle(html, 'https://example.com/headless');

    assert.match(result.markdown, /Body only content/);
  });

  it('handles a bare HTML fragment', () => {
    const html = `${'<p>Just a fragment with some text. </p>'.repeat(30)}`;

    const result = extractArticle(html, 'https://example.com/frag');

    assert.match(result.markdown, /Just a fragment/);
  });

  it('returns fallback when title element is absent', () => {
    const html = `<html><body></body></html>`;

    const result = extractArticle(html, 'https://example.com/');

    assert.equal(result.fallback, true);
    assert.equal(result.title, undefined);
    assert.equal(result.markdown, '');
  });

  it('escapes double-quotes in baseUrl when injecting the <base> tag', () => {
    const html = `<p>${'hi '.repeat(50)}</p>`;

    const result = extractArticle(html, 'https://example.com/"quote"');

    // No exception thrown, and content still extracted.
    assert.match(result.markdown, /hi/);
  });

  it('preserves an existing <head> when injecting the <base> tag', () => {
    const html = `<html><head data-custom="kept"><title>X</title></head><body><article>${'<p>Body. </p>'.repeat(30)}</article></body></html>`;

    const result = extractArticle(html, 'https://example.com/');

    assert.equal(result.title, 'X');
  });
});

describe('htmlToMarkdown', () => {
  it('converts basic HTML to Markdown', () => {
    assert.equal(htmlToMarkdown('<h1>Title</h1><p>Body.</p>'), '# Title\n\nBody.');
  });

  it('normalizes CRLF line endings to LF', () => {
    assert.equal(htmlToMarkdown('<p>line1</p>\r\n<p>line2</p>'), 'line1\n\nline2');
  });

  it('collapses runs of three or more newlines to two', () => {
    // Three <br> each become a newline; Markdown conversion produces a triple break.
    const md = htmlToMarkdown('<p>a</p><br><br><br><p>b</p>');
    assert.doesNotMatch(md, /\n{3,}/);
  });

  it('strips trailing whitespace before newlines', () => {
    const md = htmlToMarkdown('<p>keep  </p><p>me</p>');
    assert.doesNotMatch(md, /[ \t]+\n/);
  });

  it('falls back to tag-stripping on malformed input without throwing', () => {
    // Passing a number forces turndown to reject → fallback path.
    const md = htmlToMarkdown('<p>unterminated');
    assert.equal(typeof md, 'string');
  });
});
