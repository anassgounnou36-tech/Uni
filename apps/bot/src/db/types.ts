export type SqlRow = Record<string, unknown>;

export type SqlQueryResult<T extends SqlRow = SqlRow> = {
  rows: T[];
};

export interface SqlAdapter {
  query<T extends SqlRow = SqlRow>(sql: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
  close(): Promise<void>;
}
