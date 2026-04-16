import type { Pool, PoolClient } from 'pg';
import type { NewsSourceKey } from './sources.ts';

export interface NewsArticleRecord {
  readonly id: string;
  readonly source: NewsSourceKey;
  readonly sourceRank: number;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly content: string;
  readonly publishedAt: Date | null;
  readonly fetchedAt: Date;
}

export interface ArticleToInsert {
  readonly source: NewsSourceKey;
  readonly sourceRank: number;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly content: string;
  readonly publishedAt: Date | null;
}

interface NewsArticleRow {
  id: string;
  source: NewsSourceKey;
  source_rank: number;
  url: string;
  title: string;
  description: string | null;
  content: string;
  published_at: Date | null;
  fetched_at: Date;
}

const SELECT_COLUMNS = `
  id, source, source_rank, url, title, description, content, published_at, fetched_at
`;

function mapRow(row: NewsArticleRow): NewsArticleRecord {
  return {
    id: row.id,
    source: row.source,
    sourceRank: row.source_rank,
    url: row.url,
    title: row.title,
    description: row.description,
    content: row.content,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
  };
}

export class NewsArticlesRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Atomically replace the cache with the given articles. If `articles` is empty
   * this is a no-op — we never blank the cache on a failed refresh.
   */
  async replaceAll(articles: readonly ArticleToInsert[]): Promise<void> {
    if (articles.length === 0) return;

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM news_articles');

      const params: unknown[] = [];
      const placeholders: string[] = [];
      for (const a of articles) {
        const base = params.length;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
        );
        params.push(
          a.source,
          a.sourceRank,
          a.url,
          a.title,
          a.description,
          a.content,
          a.publishedAt,
        );
      }

      await client.query(
        `INSERT INTO news_articles
           (source, source_rank, url, title, description, content, published_at)
         VALUES ${placeholders.join(', ')}`,
        params,
      );

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* rollback error is secondary; surface the original */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async listAll(): Promise<NewsArticleRecord[]> {
    const { rows } = await this.pool.query<NewsArticleRow>(
      `SELECT ${SELECT_COLUMNS} FROM news_articles ORDER BY source, source_rank`,
    );
    return rows.map(mapRow);
  }
}
