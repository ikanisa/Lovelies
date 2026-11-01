import { ApiError, type QueueAdmission } from './types.ts';

/** Legacy in-process test/provider bindings return void. The production
 * PostgresJobQueue always returns a receipt, including an independently checked
 * domain disposition for a terminal queue row. Never resurrect a stopped job
 * merely because an outbox still contains its stable key. */
export function requireQueueAdmission(receipt: QueueAdmission | void): void {
    if (receipt === undefined) return;
    const runnable = ['pending', 'processing'].includes(receipt.state)
        && ['queued', 'existing'].includes(receipt.admission)
        && receipt.domain_terminal === false;
    const settled = ['completed', 'failed'].includes(receipt.state)
        && receipt.admission === 'terminal' && receipt.domain_terminal === true;
    if (!/^[0-9a-f]{64}$/.test(receipt.id) || (!runnable && !settled))
        throw new ApiError(503, 'job_queue_reconciliation_required');
}
