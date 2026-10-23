import postgres from 'postgres';
export function connectDatabase(url) {
  let parsed; try { parsed = new URL(url); } catch { throw new Error('PUSH_DATABASE_URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username) throw new Error('invalid_push_database_configuration');
  const sql = postgres(url, { max: 4, ssl: { rejectUnauthorized: true }, connect_timeout: 10, idle_timeout: 20, prepare: false, onnotice: () => {} });
  const wrap = connection => ({ exec: text => connection.unsafe(text).simple(), query: (text, values = []) => connection.unsafe(text, values), transaction: callback => connection.begin(inner => callback(wrap(inner))) });
  return { ...wrap(sql), close: () => sql.end({ timeout: 5 }) };
}
