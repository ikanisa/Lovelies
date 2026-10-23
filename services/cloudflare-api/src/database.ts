import { ApiError, type Database } from './types';

type Binding = string | number | null | ArrayBuffer;
export interface SqlStoragePort {
  exec(query: string, ...bindings: Binding[]): { toArray(): Record<string, unknown>[] };
}
export interface SqlTransactionPort {
  sql: SqlStoragePort;
  transactionSync<T>(callback: () => T): T;
}

/** Every cursor is consumed within this synchronous call. No cursor or
 * transaction is held across network/crypto awaits. */
export class SqlDatabase implements Database {
  constructor(private readonly storage: SqlTransactionPort) {}

  all<T = Record<string, unknown>>(sql: string, ...bindings: Binding[]): T[] {
    if (bindings.length > 100) throw new ApiError(500, 'sql_binding_limit');
    return this.storage.sql.exec(sql, ...bindings).toArray() as T[];
  }

  one<T = Record<string, unknown>>(sql: string, ...bindings: Binding[]): T | null {
    const rows = this.all<T>(sql, ...bindings);
    if (rows.length > 1) throw new ApiError(500, 'non_unique_database_row');
    return rows[0] ?? null;
  }

  run(sql: string, ...bindings: Binding[]): void {
    this.all(sql, ...bindings);
  }

  transaction<T>(callback: () => T): T {
    if (callback.constructor.name === 'AsyncFunction') {
      throw new ApiError(500, 'async_transaction_forbidden');
    }
    return this.storage.transactionSync(() => {
      const result = callback();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new ApiError(500, 'async_transaction_forbidden');
      }
      return result;
    });
  }
}
