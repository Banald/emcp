import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  type ArticleToInsert,
  type NewsArticleRecord,
  NewsArticlesRepository,
} from './articles-repo.ts';

interface ClientCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

function makeClient(opts: { throwOnSql?: RegExp } = {}): {
  client: PoolClient;
  calls: ClientCall[];
  released: boolean;
} {
  const calls: ClientCall[] = [];
  let released = false;

  const query = mock.fn(async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    if (opts.throwOnSql?.test(sql)) {
      throw new Error('boom');
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult<QueryResultRow>;
  });

  const client = {
    query,
    release: () => {
      released = true;
    },
  } as unknown as PoolClient;

  return {
    client,
    calls,
    get released() {
      return released;
    },
  };
}

function makePool(client: PoolClient, poolQueryRows: QueryResultRow[] = []): Pool {
  return {
    connect: mock.fn(async () => client),
    query: mock.fn(
      async () =>
        ({
          rows: poolQueryRows,
          rowCount: poolQueryRows.length,
        }) as unknown as QueryResult<QueryResultRow>,
    ),
  } as unknown as Pool;
}

const sampleArticle: ArticleToInsert = {
  source: 'aftonbladet',
  sourceRank: 1,
  url: 'https://www.aftonbladet.se/a',
  title: 'Test',
  description: 'Summary',
  content: '# Body',
  publishedAt: new Date('2026-04-15T12:00:00Z'),
};

describe('NewsArticlesRepository', () => {
  beforeEach(() => {
    mock.reset();
  });

  describe('replaceAll', () => {
    it('is a no-op when given zero articles', async () => {
      const { client, calls } = makeClient();
      const pool = makePool(client);
      const repo = new NewsArticlesRepository(pool);

      await repo.replaceAll([]);

      assert.equal(calls.length, 0);
      const connect = pool.connect as unknown as ReturnType<typeof mock.fn>;
      assert.equal(connect.mock.callCount(), 0);
    });

    it('issues BEGIN, DELETE, INSERT, COMMIT in order for a single article', async () => {
      const { client, calls, released: _released } = makeClient();
      const pool = makePool(client);
      const repo = new NewsArticlesRepository(pool);

      await repo.replaceAll([sampleArticle]);

      assert.equal(calls.length, 4);
      assert.match(calls[0]?.sql ?? '', /BEGIN/);
      assert.match(calls[1]?.sql ?? '', /DELETE FROM news_articles/);
      assert.match(calls[2]?.sql ?? '', /INSERT INTO news_articles/);
      assert.match(calls[3]?.sql ?? '', /COMMIT/);
    });

    it('binds one placeholder per column per row', async () => {
      const { client, calls } = makeClient();
      const pool = makePool(client);
      const repo = new NewsArticlesRepository(pool);

      const articles: ArticleToInsert[] = [
        sampleArticle,
        {
          ...sampleArticle,
          sourceRank: 2,
          url: 'https://www.aftonbladet.se/b',
          title: 'Second',
          description: null,
          publishedAt: null,
        },
      ];
      await repo.replaceAll(articles);

      const insert = calls[2];
      assert.ok(insert);
      // 2 rows * 7 params = 14 placeholders $1..$14
      assert.match(insert.sql, /\$14\b/);
      assert.doesNotMatch(insert.sql, /\$15\b/);
      assert.equal(insert.params?.length, 14);
      // First row bindings:
      assert.equal(insert.params?.[0], 'aftonbladet');
      assert.equal(insert.params?.[1], 1);
      assert.equal(insert.params?.[4], 'Summary');
      // Second row bindings:
      assert.equal(insert.params?.[7], 'aftonbladet');
      assert.equal(insert.params?.[8], 2);
      assert.equal(insert.params?.[11], null);
      assert.equal(insert.params?.[13], null);
    });

    it('ROLLBACKs and surfaces the error when INSERT throws', async () => {
      const { client, calls } = makeClient({ throwOnSql: /INSERT/ });
      const pool = makePool(client);
      const repo = new NewsArticlesRepository(pool);

      await assert.rejects(() => repo.replaceAll([sampleArticle]), /boom/);

      const sqls = calls.map((c) => c.sql);
      assert.ok(sqls.some((s) => /BEGIN/.test(s)));
      assert.ok(sqls.some((s) => /ROLLBACK/.test(s)));
      assert.ok(!sqls.some((s) => /COMMIT/.test(s)));
    });

    it('releases the client even when a query throws', async () => {
      let released = false;
      const query = mock.fn(async (sql: string) => {
        if (/INSERT/.test(sql)) throw new Error('boom');
        return { rows: [], rowCount: 0 } as unknown as QueryResult<QueryResultRow>;
      });
      const client = {
        query,
        release: () => {
          released = true;
        },
      } as unknown as PoolClient;
      const pool = makePool(client);
      const repo = new NewsArticlesRepository(pool);

      await assert.rejects(() => repo.replaceAll([sampleArticle]));

      assert.equal(released, true);
    });

    it('tolerates a ROLLBACK that itself fails (surfaces the original error)', async () => {
      let step = 0;
      const query = mock.fn(async (sql: string) => {
        step++;
        if (/INSERT/.test(sql)) throw new Error('insert failed');
        if (/ROLLBACK/.test(sql)) throw new Error('rollback failed');
        void step;
        return { rows: [], rowCount: 0 } as unknown as QueryResult<QueryResultRow>;
      });
      const client = { query, release: () => {} } as unknown as PoolClient;
      const pool = makePool(client);
      const repo = new NewsArticlesRepository(pool);

      await assert.rejects(() => repo.replaceAll([sampleArticle]), /insert failed/);
    });
  });

  describe('listAll', () => {
    it('runs a SELECT ordered by source, source_rank', async () => {
      const { client } = makeClient();
      const pool = makePool(client, []);
      const repo = new NewsArticlesRepository(pool);

      const results = await repo.listAll();

      assert.deepEqual(results, []);
      const poolQuery = pool.query as unknown as ReturnType<typeof mock.fn>;
      assert.equal(poolQuery.mock.callCount(), 1);
      const sql = poolQuery.mock.calls[0]?.arguments[0] as string;
      assert.match(sql, /SELECT/);
      assert.match(sql, /FROM news_articles/);
      assert.match(sql, /ORDER BY source, source_rank/);
    });

    it('maps snake_case columns to camelCase record fields', async () => {
      const row = {
        id: 'uuid-1',
        source: 'expressen',
        source_rank: 3,
        url: 'https://www.expressen.se/a',
        title: 'Hej',
        description: null,
        content: 'body',
        published_at: new Date('2026-04-15T12:00:00Z'),
        fetched_at: new Date('2026-04-16T14:00:00Z'),
      };
      const { client } = makeClient();
      const pool = makePool(client, [row]);
      const repo = new NewsArticlesRepository(pool);

      const [record] = await repo.listAll();

      const expected: NewsArticleRecord = {
        id: 'uuid-1',
        source: 'expressen',
        sourceRank: 3,
        url: 'https://www.expressen.se/a',
        title: 'Hej',
        description: null,
        content: 'body',
        publishedAt: new Date('2026-04-15T12:00:00Z'),
        fetchedAt: new Date('2026-04-16T14:00:00Z'),
      };
      assert.deepEqual(record, expected);
    });

    it('surfaces a pg 23505 via mapPgError as ConflictError', async () => {
      const pgError = Object.assign(new Error('dup row'), { code: '23505' });
      const pool = {
        connect: mock.fn(async () => makeClient().client),
        query: mock.fn(async () => {
          throw pgError;
        }),
      } as unknown as Pool;
      const repo = new NewsArticlesRepository(pool);
      await assert.rejects(
        () => repo.listAll(),
        (err: Error) => err.name === 'ConflictError',
      );
    });
  });
});
