import { requestHash } from '../../push-provider/src/gateway.mjs';

// Use the provider implementation's established ordering, independent from
// the API implementation. These values are entirely synthetic test input.
export function dispatchHash(input) {
  return requestHash({ operation_key: input.operation_key, platform: input.platform, token: input.token,
    notification: { id: input.notification.id, title: input.notification.title, kind: input.notification.kind, entity_id: input.notification.entity_id } });
}
export function pushReceipt(input, outcome) {
  return { protocol: 'lovelies-push-dispatch-receipt-v1', operation_key: input.operation_key, request_sha256: dispatchHash(input), ...outcome };
}
export function versionedPushFixture(provider) {
  const plans = new Map();
  return async request => {
    let input;
    if (request.method === 'POST') {
      input = await request.clone().json(); plans.set(input.operation_key, input);
    } else input = plans.get(decodeURIComponent(new URL(request.url).pathname.slice('/operations/'.length)));
    if (!input) throw Error('synthetic_notification_plan_missing');
    const outcome = await provider(request);
    if (outcome instanceof Response) return Response.json(pushReceipt(input, await outcome.json()), { status: outcome.status, headers: outcome.headers });
    return pushReceipt(input, outcome);
  };
}
export async function bindSeededDelivery(h, id) {
  const row = await h.db.one(`SELECT d.operation_key,p.platform,p.token_value,n.id,n.title,n.kind,n.entity_id
    FROM notification_deliveries d JOIN push_devices p ON p.id=d.device_id JOIN notifications n ON n.id=d.notification_id WHERE d.id=?`, id);
  if (!row) throw Error('synthetic_delivery_missing');
  const input = { operation_key: row.operation_key, platform: row.platform, token: row.token_value,
    notification: { id: row.id, title: row.title, kind: row.kind, entity_id: row.entity_id } };
  await h.db.run('UPDATE notification_deliveries SET request_sha256=?,platform=? WHERE id=?', dispatchHash(input),input.platform, id);
  return input;
}
