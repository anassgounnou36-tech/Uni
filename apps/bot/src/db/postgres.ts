import { Pool } from 'pg';
import type { SqlAdapter, SqlQueryResult, SqlRow } from './types.js';

export async function createPostgresAdapter(databaseUrl: string): Promise<SqlAdapter> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('select 1');
  } catch (error) {
    await pool.end().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to create Postgres adapter for durable runtime: ${detail}`);
  }

  return {
    async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<SqlQueryResult<T>> {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async close(): Promise<void> {
      await pool.end();
    }
  };
}
