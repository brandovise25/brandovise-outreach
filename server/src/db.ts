import pg from 'pg';

export type Db = pg.Pool;

export function createDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

// Calls a SQL function that returns one jsonb value and returns it parsed.
// The API never touches tables directly; every read and write goes through public.ext_* functions.
export async function callJson<T = unknown>(db: Db, fn: string, args: unknown[] = []): Promise<T> {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`invalid function name: ${fn}`);
  const params = args.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(`select public.${fn}(${params}) as result`, args);
  return rows[0]?.result as T;
}
