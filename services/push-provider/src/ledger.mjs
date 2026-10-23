import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export class LedgerConflict extends Error {}
/** Queries use positional parameters. A PostgreSQL transaction owns each claim;
 * dispatching rows are never reclaimed, including after process death. */
export class DispatchLedger {
  constructor(db, { now = Date.now, preflightLeaseMs = 30_000, ambiguousAfterMs = 60_000 } = {}) {
    this.db = db; this.now = now; this.preflightLeaseMs = preflightLeaseMs; this.ambiguousAfterMs = ambiguousAfterMs;
  }
  async migrate() { await this.db.exec(await readFile(new URL('../migrations/202610230001_push_dispatches.sql', import.meta.url), 'utf8')); }
  async reserve(input, requestHash) {
    const now = this.now(), claim = randomUUID();
    return this.db.transaction(async tx => {
      const inserted = await tx.query(`INSERT INTO push_provider.dispatches(operation_key,request_sha256,platform,notification_id,provider_request_id,status,claim_id,lease_until,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'prepared',$6,$7,$8,$8) ON CONFLICT(operation_key) DO NOTHING RETURNING *`,
        [input.operation_key, requestHash, input.platform, input.notification.id, randomUUID(), claim, now + this.preflightLeaseMs, now]);
      if (inserted.length) return { row: inserted[0], claim };
      const [row] = await tx.query('SELECT * FROM push_provider.dispatches WHERE operation_key=$1 FOR UPDATE', [input.operation_key]);
      if (!row || row.request_sha256 !== requestHash) throw new LedgerConflict('operation_payload_conflict');
      if (row.status !== 'prepared' || Number(row.lease_until) > now) return { row, claim: null };
      const [reclaimed] = await tx.query(`UPDATE push_provider.dispatches SET claim_id=$2,lease_until=$3,updated_at=$4,provider_code=NULL WHERE operation_key=$1 AND status='prepared' RETURNING *`, [input.operation_key, claim, now + this.preflightLeaseMs, now]);
      return { row: reclaimed, claim };
    });
  }
  async preflightFailed(key, claim, code = 'provider_preflight_unavailable') {
    await this.db.query(`UPDATE push_provider.dispatches SET claim_id=NULL,lease_until=0,provider_code=$3,updated_at=$4 WHERE operation_key=$1 AND claim_id=$2 AND status='prepared'`, [key, claim, code, this.now()]);
  }
  async startDispatch(key, claim) {
    const rows = await this.db.query(`UPDATE push_provider.dispatches SET status='dispatching',claim_id=NULL,lease_until=NULL,dispatched_at=$3,updated_at=$3,provider_code=NULL
      WHERE operation_key=$1 AND claim_id=$2 AND status='prepared' AND lease_until>$3 RETURNING *`, [key, claim, this.now()]);
    return rows[0] ?? null;
  }
  async finish(key, result) {
    if (!['accepted', 'rejected', 'ambiguous'].includes(result.status)) throw new Error('invalid_provider_outcome');
    const rows = await this.db.query(`UPDATE push_provider.dispatches SET status=$2,provider_message_id=$3,provider_code=$4,retryable=$5,token_invalid=$6,updated_at=$7
      WHERE operation_key=$1 AND status IN('dispatching','ambiguous') RETURNING *`, [key, result.status, result.provider_message_id ?? null, result.provider_code ?? null, result.retryable === true, result.token_invalid === true, this.now()]);
    if (!rows.length) throw new Error('dispatch_receipt_not_saved');
    return rows[0];
  }
  async lookup(key) {
    // A crash after provider dispatch and before receipt persistence is unknown.
    // This expiration changes presentation only; it never reopens dispatch.
    await this.db.query(`UPDATE push_provider.dispatches SET status='ambiguous',provider_code='dispatch_result_unconfirmed',updated_at=$2 WHERE operation_key=$1 AND status='dispatching' AND dispatched_at<=$3`, [key, this.now(), this.now() - this.ambiguousAfterMs]);
    const [row] = await this.db.query('SELECT * FROM push_provider.dispatches WHERE operation_key=$1', [key]);
    return row ?? null;
  }
}
export function receipt(row, key, now = Date.now()) {
  if (!row) return { operation_key: key, status: 'unknown' };
  const state = row.status === 'prepared' ? (Number(row.lease_until) > now ? 'preparing' : 'not_dispatched') : row.status;
  return { operation_key: row.operation_key, status: state,
    ...(state === 'accepted' ? { provider_message_id: row.provider_message_id } : {}),
    ...(row.provider_code ? { provider_code: row.provider_code } : {}),
    ...(state === 'rejected' ? { retryable: row.retryable === true, token_invalid: row.token_invalid === true } : {}) };
}
