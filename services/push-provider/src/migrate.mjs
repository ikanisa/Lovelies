import { connectDatabase } from './database.mjs';
import { DispatchLedger } from './ledger.mjs';
const db = connectDatabase(process.env.PUSH_DATABASE_URL);
try { await new DispatchLedger(db).migrate(); }
finally { await db.close(); }
