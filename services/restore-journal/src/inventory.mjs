/** Independent write inventory. Metadata/enumeration only: no DB connections,
 * Storage requests, cleanup executor, serving initializer or recovery clearance. */
import { PROJECT_ID, PROTOCOL, GENESIS_HASH, authenticate, canonical, sha256, exact, plain, fail,
  loadHead, headView, checkedReceipt, appendEventTransaction, response, errorResponse } from './journal.mjs';
import { CONTROL_KEY, BINDING_KEY, planKey, prepareKey, commitKey, validateMarker,
  checkedBinding as checkedV1Binding, checkedPlan as checkedV1Plan, loadControl as loadV1Control } from './operations.mjs';
import { validateDescriptorV2, validateLinkV2, validateD2LinkTarget } from './inventory-descriptors-v2.mjs';
import { INVENTORY_PROTOCOL, LIMITS, equal, uuid, digest, unsigned, positive, nullableUuid, copy, bounded,
  envelope, cursor, chainName, chainTag, recordKey, metaKey, writeKey, linkKey, observationKey, cutKey,
  cutHeadKey, progressKey, recoveryKey, hashContent, keyHash, genesis, clock, validateDescriptor,
  validateLink, validatePrepareV2, validateObservation, requestGate, inertGate, readCanonical, utf8 } from './inventory-values.mjs';

const CHAIN_NAMES = ['registrations', 'observations'];
const reasons = new Set(['marker_mismatch', 'acknowledgement_mismatch', 'journal_advanced', 'planned_restore', 'preexisting_restrictions']);
const controlFields = ['version', 'project_id', 'binding_hash', 'state', 'marker', 'pending_operation_id', 'recovery_generation_id',
  'quarantine', 'writer_generation_id', 'minimum_operation_version', 'inventory_protocol', 'registration_head', 'observation_head', 'coverage_anchor_hash',
  'upgrade_id', 'upgrade_receipt_hash', 'upgrade_control_hash'];
const controlFields3 = [...controlFields, 'capability_id', 'capability_receipt_hash', 'capability_archive_hash', 'capability_version', 'minimum_descriptor_version', 'minimum_link_version'];
const capFields = ['version','project_id','capability_id','input_hash','old_control_hash','old_writer_generation_id','new_writer_generation_id','marker','restriction_head','registration_head','observation_head','old_upgrade_id','old_upgrade_receipt_hash','old_upgrade_control_hash','coverage_anchor_hash','recorded_at','hash'];
const capKey = id => 'inventory:capability:' + id;
const capArchiveKey = id => 'inventory:capability-archive:' + id;
const generationKey = id => 'inventory:writer-generation:' + id;
const inputFields = ['version', 'project_id', 'operation_id', 'input_hash', 'expected', 'writer_generation_id', 'allocations', 'events', 'resources', 'links'];
const headOf = (control, chain) => chain === 'registrations' ? control.registration_head : control.observation_head;
const fieldOf = chain => chain === 'registrations' ? 'registration_head' : 'observation_head';
const receiptFields = ['version', 'protocol', 'project_id', 'database_id', 'incarnation_id', 'chain', 'sequence', 'previous_hash', 'payload_hash', 'payload', 'recorded_at', 'hash'];
const corrupt = () => fail(503, 'inventory_integrity_failed');
const persisted = fn => { try { return fn(); } catch { corrupt(); } };
const persistedAsync = async (fn, gate) => { try { return await gate.wait(fn()); } catch { gate.check(); corrupt(); } };
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const view = control => ({ protocol: INVENTORY_PROTOCOL, project_id: PROJECT_ID, control: copy(control), clearance_available: false });
const finish = value => { if (value.denied) fail(value.status, value.denied); return value; };
const deny = code => ({ denied: code, status: 409 });
const stateHead = (state, cut) => headOf({ registration_head: cut.registration_head, observation_head: cut.observation_head }, state.chain);
async function noRecords(txn, prefixes, ctx) {
  for (const prefix of prefixes) {
    ctx.gate.check(); const rows = await ctx.gate.wait(txn.list({ prefix, limit: 1 })); ctx.gate.check();
    if (rows.size) corrupt();
  }
}
async function put(txn, values, result, gate) {
  bounded(result, LIMITS.response, 'inventory_response_too_large', 503); gate.check();
  await gate.wait(txn.put(values)); gate.check(); return result;
}
function context(options = {}) {
  if (options.format === 3 && (!Number.isInteger(options.pageLimit ?? 1) || (options.pageLimit ?? 1) < 1 || (options.pageLimit ?? 1) > 8)) fail(503, 'inventory_configuration_invalid');
  return { gate: options.gate ?? inertGate(), now: options.now ?? Date.now, plans: new Map(), anchors: new Map(), reads: { plans: 0, restriction_receipts: 0 }, pageLimit: options.pageLimit ?? 1, format: options.format ?? 2 };
}
async function transact(storage, ctx, callback) {
  // A cancelled/lost response may race an already durable commit. Race the
  // delivery as well as every callback await; never claim that a failed reply
  // proves rollback. Each callback still checks the gate before/after effects.
  return ctx.gate.wait(storage.transaction(async txn => {
    // Native DO transaction callbacks may retry. Never reuse checked values
    // from an abandoned snapshot in the next admission/validation pass.
    ctx.plans = new Map(); ctx.anchors = new Map(); ctx.heads = null; ctx.capCutSequence=undefined;ctx.gate.check(); return callback(txn);
  }));
}
function descriptorHistory(value, input) {
  return value?.version === 1 ? validateDescriptor(value,input) : value?.version === 2 ? validateDescriptorV2(value,input) : fail(400,'inventory_descriptor_invalid');
}
function linkHistory(value, input) {
  return value?.version === 1 ? validateLink(value,input) : value?.version === 2 ? validateLinkV2(value,input) : fail(400,'inventory_link_invalid');
}
function prepareHistory(value) {
  if (!plain(value) || !Array.isArray(value.resources) || !Array.isArray(value.links) || value.resources.length + value.links.length > 1) fail(400,'operation_invalid');
  const old = validatePrepareV2({...value,resources:[],links:[]});
  const input = {...old,resources:value.resources.map(x=>descriptorHistory(x,value)),links:value.links.map(x=>linkHistory(x,value))};
  return copy(bounded(input,LIMITS.operation,'operation_too_large'));
}
function recordLimit(record) {
  const item=record?.payload?.item;return record?.chain==='registrations' && item?.version===2 ? 10240 : LIMITS.record;
}
async function anchoredPlan(txn, id, expectedHash, record, ctx) {
  const key = id + ':' + expectedHash;
  let stored = ctx.anchors.get(key);
  if (!stored) {
    stored = await ctx.gate.wait(txn.get(planKey(id)));
    if (!exact(stored, ['plan', 'plan_hash']) || stored.plan_hash !== expectedHash ||
        !exact(stored.plan, [...inputFields, 'next', 'prepared_at', 'receipts', 'registration_before', 'registration_after', 'inventory_receipts'])) corrupt();
    persisted(() => bounded(stored, LIMITS.response)); persisted(() => ctx.format===2 ? validatePrepareV2(planInput(stored.plan)) : prepareHistory(planInput(stored.plan)));
    persisted(() => validateMarker(stored.plan.next));
    if (stored.plan.operation_id !== id || stored.plan_hash !== await ctx.gate.hash(canonical(stored.plan))) corrupt();
    if (!equal(await ctx.gate.wait(txn.get(prepareKey(stored.plan.next.checkpoint.revision))), { operation_id: id, plan_hash: expectedHash })) corrupt();
    ctx.anchors.set(key, stored);
  }
  if (record && (!Array.isArray(stored.plan.inventory_receipts) || stored.plan.inventory_receipts.length !== 1 ||
      !equal(stored.plan.inventory_receipts[0], record) || stored.plan.prepared_at !== record.recorded_at ||
      !equal(stored.plan.registration_after, headView(record)) || stored.plan.registration_before?.hash !== record.previous_hash ||
      stored.plan.registration_before?.sequence !== record.sequence - 1 || stored.plan.input_hash !== record.payload.input_hash ||
      !equal(stored.plan.resources[0] ?? stored.plan.links[0], record.payload.item))) corrupt();
  return stored;
}
async function receiptHash(record, ctx) {
  const { payload, hash, ...content } = record;
  return ctx.gate.hash(canonical(content));
}
async function checkedRecord(txn, chain, sequence, binding, ctx) {
  if (!positive(sequence)) corrupt();
  const record = await ctx.gate.wait(txn.get(recordKey(chain, sequence)));
  if (!exact(record, receiptFields) || record.version !== 1 || record.protocol !== INVENTORY_PROTOCOL || record.project_id !== PROJECT_ID ||
      record.database_id !== binding.database_id || record.incarnation_id !== binding.initial_marker.incarnation_id || record.chain !== chain ||
      record.sequence !== sequence || !digest(record.previous_hash) || !digest(record.payload_hash) || !positive(record.recorded_at) || !digest(record.hash)) corrupt();
  persisted(() => bounded(record, recordLimit(record)));
  if (record.payload_hash !== await ctx.gate.hash(canonical(record.payload)) || record.hash !== await receiptHash(record, ctx)) corrupt();
  if (chain === 'registrations') {
    const p = record.payload;
    if (!exact(p, ['entry_kind', 'operation_id', 'input_hash', 'ordinal', 'item_hash', 'item']) || !uuid(p.operation_id) || !digest(p.input_hash) || p.ordinal !== 0 || !digest(p.item_hash)) corrupt();
    if((ctx.format===2||ctx.capCutSequence!==undefined&&record.sequence<=ctx.capCutSequence)&&p.item?.version!==1)corrupt();
    if (p.entry_kind === 'write') {
      persisted(() => descriptorHistory(p.item));
      const index = await ctx.gate.wait(txn.get(writeKey(p.item.write_id)));
      if (!exact(index, ['version', 'project_id', 'write_id', 'operation_id', 'plan_hash', 'descriptor_hash', 'sequence', 'hash', 'action']) ||
          index.version !== 1 || index.project_id !== PROJECT_ID || index.write_id !== p.item.write_id || index.operation_id !== p.operation_id ||
          !digest(index.plan_hash) || index.descriptor_hash !== p.item_hash || index.sequence !== sequence || index.hash !== record.hash || index.action !== p.item.action) corrupt();
    } else if (p.entry_kind === 'link') {
      persisted(() => linkHistory(p.item));
      const index = await ctx.gate.wait(txn.get(linkKey(p.operation_id)));
      if (!exact(index, ['version', 'project_id', 'operation_id', 'plan_hash', 'item_hash', 'sequence', 'hash']) || index.version !== 1 ||
          index.project_id !== PROJECT_ID || index.operation_id !== p.operation_id || !digest(index.plan_hash) || index.item_hash !== p.item_hash ||
          index.sequence !== sequence || index.hash !== record.hash) corrupt();
    } else corrupt();
    if (p.item.operation_id !== p.operation_id || p.entry_kind === 'write' &&
        (p.item.database_id !== record.database_id || p.item.incarnation_id !== record.incarnation_id) ||
        p.item_hash !== await ctx.gate.hash(canonical(p.item))) corrupt();
    const ownIndex = await ctx.gate.wait(txn.get(p.entry_kind === 'write' ? writeKey(p.item.write_id) : linkKey(p.operation_id)));
    await anchoredPlan(txn, p.operation_id, ownIndex.plan_hash, record, ctx);
  } else {
    persisted(() => validateObservation(record.payload));
    const index = await ctx.gate.wait(txn.get(observationKey(record.payload.observation_id)));
    if (!exact(index, ['version', 'project_id', 'observation_id', 'sequence', 'hash', 'input_hash']) || index.version !== 1 ||
        index.project_id !== PROJECT_ID || index.observation_id !== record.payload.observation_id || index.sequence !== sequence ||
        index.hash !== record.hash || index.input_hash !== record.payload_hash) corrupt();
    const write = await ctx.gate.wait(txn.get(writeKey(record.payload.write_id)));
    if (!plain(write) || !positive(write.sequence)) corrupt();
    const registration = await checkedRecord(txn, 'registrations', write.sequence, binding, ctx);
    if (registration.hash !== record.payload.registration_hash || write.plan_hash !== record.payload.plan_hash ||
        registration.payload.item.write_id !== record.payload.write_id) corrupt();
    if (record.payload.kind === 'publication') {
      const linked = await ctx.gate.wait(txn.get(linkKey(record.payload.result.publication_operation_id)));
      if (!plain(linked) || !positive(linked.sequence) || linked.plan_hash !== record.payload.result.publication_plan_hash) corrupt();
      const publication = await checkedRecord(txn, 'registrations', linked.sequence, binding, ctx), link = publication.payload.item;
      if (publication.payload.entry_kind !== 'link' || link.target_write_id !== record.payload.write_id ||
          link.target_descriptor_hash !== registration.payload.item_hash || !sameTarget(link, registration.payload.item)) corrupt();
      if(link.version===2){if(registration.payload.item.version!==2)corrupt();await persistedAsync(() => validateD2LinkTarget(link,registration.payload.item),ctx.gate);}
      const accepted = await anchoredPlan(txn, linked.operation_id, linked.plan_hash, publication, ctx);
      const committed = await ctx.gate.wait(txn.get(commitKey(accepted.plan.next.checkpoint.revision)));
      if (!exact(committed, ['version', 'project_id', 'marker', 'operation_id', 'plan_hash', 'registration_after', 'writer_generation_id', 'committed_at']) ||
          committed.version !== 2 || committed.project_id !== PROJECT_ID || committed.operation_id !== linked.operation_id || committed.plan_hash !== linked.plan_hash ||
          !equal(committed.marker, accepted.plan.next) || !equal(committed.registration_after, accepted.plan.registration_after) ||
          committed.writer_generation_id !== accepted.plan.writer_generation_id || !positive(committed.committed_at) || committed.committed_at < accepted.plan.prepared_at) corrupt();
    }
  }
  return record;
}
async function checkedMeta(txn, chain, binding, ctx) {
  const meta = await ctx.gate.wait(txn.get(metaKey(chain))), initial = await genesis(binding, chain, ctx.gate);
  if (!exact(meta, Object.keys(initial)) || meta.version !== 1 || meta.project_id !== PROJECT_ID || meta.database_id !== binding.database_id ||
      meta.incarnation_id !== binding.initial_marker.incarnation_id || !unsigned(meta.sequence) || !digest(meta.hash) || !unsigned(meta.recorded_at)) corrupt();
  if (meta.sequence === 0) { if (!equal(meta, initial)) corrupt(); }
  else {
    const last = await checkedRecord(txn, chain, meta.sequence, binding, ctx);
    if (last.hash !== meta.hash || last.recorded_at !== meta.recorded_at) corrupt();
  }
  // The only key lexically after the claimed last receipt may be this meta key.
  const suffix = await ctx.gate.wait(txn.list({ prefix: 'inventory:' + chainTag(chain) + ':', startAfter: recordKey(chain, meta.sequence), limit: 2 }));
  if (suffix.size !== 1 || !suffix.has(metaKey(chain))) corrupt();
  const first = await ctx.gate.wait(txn.list({ prefix: 'inventory:' + chainTag(chain) + ':', limit: 1 }));
  if (first.size !== 1 || !first.has(meta.sequence === 0 ? metaKey(chain) : recordKey(chain, 1))) corrupt();
  return meta;
}
async function checkedCursor(txn, chain, value, head, binding, ctx) {
  persisted(() => cursor(value)); persisted(() => cursor(head));
  if (value.sequence > head.sequence) corrupt();
  const hash = value.sequence === 0 ? (await genesis(binding, chain, ctx.gate)).hash : (await checkedRecord(txn, chain, value.sequence, binding, ctx)).hash;
  if (value.hash !== hash || value.sequence === head.sequence && value.hash !== head.hash) corrupt();
}
async function checkpoint(input, restrictionCursor, before, after, receipts, ctx) {
  return ctx.gate.hash(canonical({ kind: 'database-checkpoint-v2', input, restriction_cursor: restrictionCursor,
    registration_before: before, registration_after: after, inventory_receipt_hashes: receipts.map(x => x.hash) }));
}
function planInput(plan) { return Object.fromEntries(inputFields.map(key => [key, plan[key]])); }
async function plan(txn, id, expectedHash, binding, ctx) {
  const cacheKey = id + ':' + (expectedHash ?? 'lookup');
  if (ctx.plans.has(cacheKey)) return ctx.plans.get(cacheKey);
  const stored = await ctx.gate.wait(txn.get(planKey(id)));
  if (stored === undefined) return undefined;
  if (stored?.plan?.version === 1) {
    const old = await ctx.gate.wait(checkedV1Plan(txn, id));
    if (expectedHash && old.plan_hash !== expectedHash) corrupt();
    ctx.plans.set(cacheKey, old); return old;
  }
  if (!exact(stored, ['plan', 'plan_hash']) || !digest(stored.plan_hash) || expectedHash && stored.plan_hash !== expectedHash ||
      !exact(stored.plan, [...inputFields, 'next', 'prepared_at', 'receipts', 'registration_before', 'registration_after', 'inventory_receipts'])) corrupt();
  const p = stored.plan, input = persisted(() => ctx.format===2 ? validatePrepareV2(planInput(p)) : prepareHistory(planInput(p))), next = persisted(() => validateMarker(p.next));
  persisted(() => bounded(stored, LIMITS.response));
  if (input.expected.database_id !== binding.database_id || input.expected.incarnation_id !== binding.initial_marker.incarnation_id || p.operation_id !== id || !positive(p.prepared_at) || !Array.isArray(p.receipts) || p.receipts.length !== p.events.length ||
      !Array.isArray(p.inventory_receipts) || p.inventory_receipts.length !== p.resources.length + p.links.length ||
      next.database_id !== input.expected.database_id || next.incarnation_id !== input.expected.incarnation_id ||
      next.checkpoint.revision !== input.expected.checkpoint.revision + 1 || !positive(next.checkpoint.revision) ||
      stored.plan_hash !== await ctx.gate.hash(canonical(p))) corrupt();
  const prepared = await ctx.gate.wait(txn.get(prepareKey(next.checkpoint.revision)));
  if (!equal(prepared, { operation_id: id, plan_hash: stored.plan_hash })) corrupt();
  let previous = input.expected.cursor;
  if (previous.sequence > 0) { ctx.reads.restriction_receipts++; if ((await ctx.gate.wait(checkedReceipt(txn, previous.sequence))).hash !== previous.hash) corrupt(); }
  for (let index = 0; index < p.receipts.length; index++) {
    const receipt = p.receipts[index];
    if (!plain(receipt) || receipt.sequence !== previous.sequence + 1 || receipt.previous_hash !== previous.hash || receipt.recorded_at !== p.prepared_at || !equal(receipt.event, input.events[index])) corrupt();
    ctx.reads.restriction_receipts++;
    if (!equal(receipt, await ctx.gate.wait(checkedReceipt(txn, receipt.sequence)))) corrupt();
    previous = headView(receipt);
  }
  if (!equal(previous, next.cursor)) corrupt();
  persisted(() => cursor(p.registration_before)); persisted(() => cursor(p.registration_after));
  await checkedCursor(txn, 'registrations', p.registration_before, p.registration_after, binding, ctx);
  if (p.inventory_receipts.length) {
    const own = p.inventory_receipts[0], item = input.resources[0] ?? input.links[0];
    if (!plain(own) || own.sequence !== p.registration_before.sequence + 1 || own.previous_hash !== p.registration_before.hash ||
        own.recorded_at !== p.prepared_at || !equal(headView(own), p.registration_after) || own.payload?.operation_id !== id ||
        own.payload.input_hash !== input.input_hash || !equal(own.payload.item, item) ||
        !equal(own, await checkedRecord(txn, 'registrations', own.sequence, binding, ctx))) corrupt();
    const index = await ctx.gate.wait(txn.get(input.resources.length ? writeKey(item.write_id) : linkKey(id)));
    if (index.plan_hash !== stored.plan_hash) corrupt();
  } else if (!equal(p.registration_before, p.registration_after)) corrupt();
  if (next.checkpoint.hash !== await checkpoint(input, next.cursor, p.registration_before, p.registration_after, p.inventory_receipts, ctx)) corrupt();
  ctx.reads.plans++; ctx.plans.set(cacheKey, stored);
  // Shallow by design: direct target/publication dependencies are checked only
  // by the typed caller, never recursively through arbitrary plan ancestry.
  return stored;
}
async function operationView(txn, operation, control, ctx) {
  const committed = await ctx.gate.wait(txn.get(commitKey(operation.plan.next.checkpoint.revision)));
  if (committed === undefined) {
    if (control.pending_operation_id !== operation.plan.operation_id || control.marker.checkpoint.revision >= operation.plan.next.checkpoint.revision) corrupt();
    return { ...operation, status: 'pending', committed_at: null };
  }
  const p = operation.plan;
  const fields = p.version === 1 ? ['version', 'project_id', 'marker', 'operation_id', 'plan_hash', 'committed_at'] :
    ['version', 'project_id', 'marker', 'operation_id', 'plan_hash', 'registration_after', 'writer_generation_id', 'committed_at'];
  if (!exact(committed, fields) || committed.version !== p.version || committed.project_id !== PROJECT_ID ||
      committed.operation_id !== p.operation_id || committed.plan_hash !== operation.plan_hash || !equal(committed.marker, p.next) ||
      !positive(committed.committed_at) || committed.committed_at < p.prepared_at || p.version === 2 &&
      (!equal(committed.registration_after, p.registration_after) || committed.writer_generation_id !== p.writer_generation_id)) corrupt();
  return { ...operation, status: 'committed', committed_at: committed.committed_at };
}
const upgradeFields = ['version', 'project_id', 'upgrade_id', 'input_hash', 'old_control_hash', 'writer_generation_id', 'registration_head', 'observation_head', 'recorded_at', 'hash'];
async function checkedUpgradeOrigin(txn, control, binding, ctx) {
  // Two exact owned-key reads: never select an arbitrary/latest archive or scan
  // history to infer the serving upgrade that admitted this active control.
  const receipt = await ctx.gate.wait(txn.get('inventory:upgrade:' + control.upgrade_id));
  const archived = await ctx.gate.wait(txn.get('control-archive:' + control.upgrade_id));
  if (!exact(receipt, upgradeFields) || receipt.version !== 1 || receipt.project_id !== PROJECT_ID || receipt.upgrade_id !== control.upgrade_id ||
      !digest(receipt.input_hash) || !digest(receipt.old_control_hash) || !uuid(receipt.writer_generation_id) || !positive(receipt.recorded_at) ||
      receipt.recorded_at < binding.created_at || receipt.hash !== control.upgrade_receipt_hash || receipt.old_control_hash !== control.upgrade_control_hash) corrupt();
  persisted(() => bounded(receipt, 2048));
  const { hash, ...content } = receipt;
  if (hash !== await hashContent('inventory-upgrade-v1', content, ctx.gate)) corrupt();
  if (!exact(archived, ['version', 'project_id', 'binding_hash', 'state', 'marker', 'pending_operation_id', 'recovery_generation_id', 'quarantine']) ||
      archived.version !== 1 || archived.project_id !== PROJECT_ID || archived.binding_hash !== binding.binding_hash || archived.state !== 'serving' ||
      archived.pending_operation_id !== null || archived.recovery_generation_id !== null || archived.quarantine !== null) corrupt();
  persisted(() => validateMarker(archived.marker));
  if (archived.marker.database_id !== binding.database_id || archived.marker.incarnation_id !== binding.initial_marker.incarnation_id ||
      archived.marker.checkpoint.revision > control.marker.checkpoint.revision ||
      archived.marker.checkpoint.revision === control.marker.checkpoint.revision && !equal(archived.marker, control.marker) ||
      control.upgrade_control_hash !== await ctx.gate.hash(canonical(archived))) corrupt();
  const originalInput = { version: 2, project_id: PROJECT_ID, upgrade_id: control.upgrade_id, expected: archived.marker,
    expected_control_hash: control.upgrade_control_hash, coverage_anchor_hash: control.coverage_anchor_hash };
  if (receipt.input_hash !== await ctx.gate.hash(canonical(originalInput)) ||
      !equal(receipt.registration_head, headView(await genesis(binding, 'registrations', ctx.gate))) ||
      !equal(receipt.observation_head, headView(await genesis(binding, 'observations', ctx.gate))) ||
      control.recovery_generation_id === null && control.writer_generation_id !== receipt.writer_generation_id) corrupt();
  return receipt;
}
async function checkedCapability(txn, control, binding, ctx) {
  const cap=await ctx.gate.wait(txn.get(capKey(control.capability_id)));
  const archived=await ctx.gate.wait(txn.get(capArchiveKey(control.capability_id)));
  if(!exact(cap,capFields)||cap.version!==1||cap.project_id!==PROJECT_ID||cap.capability_id!==control.capability_id||
     !digest(cap.input_hash)||!digest(cap.old_control_hash)||!uuid(cap.old_writer_generation_id)||!uuid(cap.new_writer_generation_id)||
     cap.old_writer_generation_id===cap.new_writer_generation_id||!positive(cap.recorded_at)||!digest(cap.hash)||
     cap.hash!==control.capability_receipt_hash||cap.old_control_hash!==control.capability_archive_hash)corrupt();
  persisted(()=>bounded(cap,2048));const {hash,...content}=cap;
  if(hash!==await hashContent('inventory-capability-v1',content,ctx.gate))corrupt();
  if(!exact(archived,controlFields)||archived.version!==2||archived.project_id!==PROJECT_ID||archived.binding_hash!==binding.binding_hash||
     archived.state!=='serving'||archived.pending_operation_id!==null||archived.recovery_generation_id!==null||archived.quarantine!==null||
     archived.writer_generation_id!==cap.old_writer_generation_id||archived.minimum_operation_version!==2||archived.inventory_protocol!==1||
     !equal(archived.marker,cap.marker)||!equal(archived.registration_head,cap.registration_head)||!equal(archived.observation_head,cap.observation_head)||
     !equal(archived.marker.cursor,cap.restriction_head)||archived.coverage_anchor_hash!==cap.coverage_anchor_hash||
     archived.upgrade_id!==cap.old_upgrade_id||archived.upgrade_receipt_hash!==cap.old_upgrade_receipt_hash||archived.upgrade_control_hash!==cap.old_upgrade_control_hash||
     control.upgrade_id!==archived.upgrade_id||control.upgrade_receipt_hash!==archived.upgrade_receipt_hash||control.upgrade_control_hash!==archived.upgrade_control_hash||control.coverage_anchor_hash!==archived.coverage_anchor_hash||
     await ctx.gate.hash(canonical(archived))!==cap.old_control_hash)corrupt();
  persisted(()=>validateMarker(cap.marker));for(const head of [cap.restriction_head,cap.registration_head,cap.observation_head])persisted(()=>cursor(head));
  const input={version:3,project_id:PROJECT_ID,capability_id:cap.capability_id,expected_marker:cap.marker,expected_control_hash:cap.old_control_hash,
    expected_restriction_head:cap.restriction_head,expected_registration_head:cap.registration_head,expected_observation_head:cap.observation_head};
  if(cap.input_hash!==await ctx.gate.hash(canonical(input)))corrupt();
  const origin=await checkedUpgradeOrigin(txn,archived,binding,ctx);
  if(origin.writer_generation_id!==cap.old_writer_generation_id||cap.recorded_at<origin.recorded_at)corrupt();
  const generation=await ctx.gate.wait(txn.get(generationKey(cap.new_writer_generation_id)));
  if(!equal(generation,{version:1,project_id:PROJECT_ID,writer_generation_id:cap.new_writer_generation_id,capability_id:cap.capability_id,capability_hash:cap.hash}))corrupt();
  if(cap.restriction_head.sequence===0){if(cap.restriction_head.hash!==GENESIS_HASH)corrupt();}
  else {const r=await ctx.gate.wait(checkedReceipt(txn,cap.restriction_head.sequence));if(r.hash!==cap.restriction_head.hash||r.recorded_at>cap.recorded_at)corrupt();}
  for(const [chain,head] of [['registrations',cap.registration_head],['observations',cap.observation_head]]){
    await checkedCursor(txn,chain,head,head,binding,ctx);
    if(head.sequence>0){const r=await checkedRecord(txn,chain,head.sequence,binding,ctx);if(r.recorded_at>cap.recorded_at||chain==='registrations'&&r.payload.item?.version!==1)corrupt();
      if(chain==='observations')await observationDependencies(txn,r.payload,binding,archived,ctx,cap.registration_head.sequence);}
  }
  const commit=await ctx.gate.wait(txn.get(commitKey(cap.marker.checkpoint.revision)));
  if(!commit||!equal(commit.marker,cap.marker)||!positive(commit.committed_at)||commit.committed_at>cap.recorded_at)corrupt();
  if(cap.marker.checkpoint.revision===0){
    if(!exact(commit,['version','project_id','marker','operation_id','plan_hash','committed_at'])||commit.version!==1||commit.project_id!==PROJECT_ID||
       commit.operation_id!==null||commit.plan_hash!==null||!equal(commit.marker,binding.initial_marker)||commit.committed_at!==binding.created_at)corrupt();
  }else{
    const saved=await plan(txn,commit.operation_id,commit.plan_hash,binding,ctx);
    if(!saved||(await operationView(txn,saved,archived,ctx)).status!=='committed'||!equal(saved.plan.next,cap.marker))corrupt();
    if(saved.plan.version===2){persisted(()=>validatePrepareV2(planInput(saved.plan)));if(!equal(saved.plan.registration_after,cap.registration_head)||saved.plan.writer_generation_id!==cap.old_writer_generation_id)corrupt();}
  }
  return {cap,archived,origin};
}
async function load(txn, ctx) {
  const binding = await ctx.gate.wait(checkedV1Binding(txn)), control = await ctx.gate.wait(txn.get(CONTROL_KEY));
  if (!binding && !control) {
    await noRecords(txn, ['inventory:', 'control-archive:', 'plan:', 'prepare:', 'commit:', 'recovery:'], ctx);
    fail(409, 'control_uninitialized');
  }
  if (!binding || !control) corrupt();
  if (control.version !== ctx.format || ![2,3].includes(control.version)) fail(409, 'protocol_version_unsupported');
  if (!exact(control, control.version === 3 ? controlFields3 : controlFields) || control.version !== ctx.format || control.project_id !== PROJECT_ID || control.binding_hash !== binding.binding_hash ||
      !['serving', 'pending', 'quarantined'].includes(control.state) || !nullableUuid(control.pending_operation_id) || !nullableUuid(control.recovery_generation_id) ||
      !uuid(control.writer_generation_id) || control.minimum_operation_version !== 2 || control.inventory_protocol !== 1 || !digest(control.coverage_anchor_hash) ||
      !uuid(control.upgrade_id) || !digest(control.upgrade_receipt_hash) || !digest(control.upgrade_control_hash) ||
      control.version===3&&(!uuid(control.capability_id)||!digest(control.capability_receipt_hash)||!digest(control.capability_archive_hash)||control.capability_version!==3||control.minimum_descriptor_version!==2||control.minimum_link_version!==2)) corrupt();
  persisted(() => validateMarker(control.marker));
  if (control.marker.database_id !== binding.database_id || control.marker.incarnation_id !== binding.initial_marker.incarnation_id ||
      control.state === 'serving' && control.pending_operation_id !== null || control.state === 'pending' && control.pending_operation_id === null) corrupt();
  if (control.state === 'quarantined') {
    if (!exact(control.quarantine, ['reason', 'detected_at', 'observed_marker_hash']) || !reasons.has(control.quarantine.reason) || !positive(control.quarantine.detected_at) ||
        !(control.quarantine.observed_marker_hash === null || digest(control.quarantine.observed_marker_hash))) corrupt();
  } else if (control.quarantine !== null || control.recovery_generation_id !== null) corrupt();
  const capability=control.version===3?await checkedCapability(txn,control,binding,ctx):null;
  const origin=capability?capability.origin:await checkedUpgradeOrigin(txn,control,binding,ctx);
  if(capability)ctx.capCutSequence=capability.cap.registration_head.sequence;
  if(capability && control.recovery_generation_id===null && control.writer_generation_id!==capability.cap.new_writer_generation_id)corrupt();
  const restriction = await ctx.gate.wait(loadHead(txn));
  const registrations = await checkedMeta(txn, 'registrations', binding, ctx), observations = await checkedMeta(txn, 'observations', binding, ctx);
  if (!equal(control.registration_head, headView(registrations)) || !equal(control.observation_head, headView(observations))) corrupt();
  ctx.heads = { restriction: headView(restriction), registrations: headView(registrations), observations: headView(observations) };
  if(capability){for(const [cut,head] of [[capability.cap.restriction_head,ctx.heads.restriction],[capability.cap.registration_head,ctx.heads.registrations],[capability.cap.observation_head,ctx.heads.observations]])
    if(cut.sequence>head.sequence||cut.sequence===head.sequence&&cut.hash!==head.hash)corrupt();
    if(capability.cap.marker.checkpoint.revision>control.marker.checkpoint.revision||capability.cap.marker.checkpoint.revision===control.marker.checkpoint.revision&&!equal(capability.cap.marker,control.marker))corrupt();}
  const commit = await ctx.gate.wait(txn.get(commitKey(control.marker.checkpoint.revision)));
  if (!commit || !equal(commit.marker, control.marker)) corrupt();
  if (control.marker.checkpoint.revision === 0) {
    if (!exact(commit, ['version', 'project_id', 'marker', 'operation_id', 'plan_hash', 'committed_at']) || commit.version !== 1 ||
        commit.project_id !== PROJECT_ID || commit.operation_id !== null || commit.plan_hash !== null || !equal(commit.marker, binding.initial_marker) || commit.committed_at !== binding.created_at) corrupt();
  } else {
    const committedPlan = await plan(txn, commit.operation_id, commit.plan_hash, binding, ctx);
    if (!committedPlan || (await operationView(txn, committedPlan, control, ctx)).status !== 'committed') corrupt();
  }
  const commits = await ctx.gate.wait(txn.list({ prefix: 'commit:', reverse: true, limit: 1 }));
  if (commits.size !== 1 || !commits.has(commitKey(control.marker.checkpoint.revision))) corrupt();
  const prepares = await ctx.gate.wait(txn.list({ prefix: 'prepare:', reverse: true, limit: 1 }));
  if (control.pending_operation_id !== null || control.marker.checkpoint.revision > 0) {
    const revision = control.marker.checkpoint.revision + (control.pending_operation_id === null ? 0 : 1), indexed = prepares.get(prepareKey(revision));
    if (prepares.size !== 1 || !exact(indexed, ['operation_id', 'plan_hash'])) corrupt();
    const latest = await plan(txn, indexed.operation_id, indexed.plan_hash, binding, ctx);
    if (!latest || latest.plan.next.checkpoint.revision !== revision ||
        control.pending_operation_id !== null && (latest.plan.operation_id !== control.pending_operation_id || !equal(latest.plan.expected, control.marker) ||
          latest.plan.version !== 2 || latest.plan.writer_generation_id !== control.writer_generation_id && control.state !== 'quarantined' ||
          !equal(latest.plan.registration_after, control.registration_head)) ||
        control.pending_operation_id === null && latest.plan.operation_id !== commit.operation_id) corrupt();
  } else if (prepares.size) corrupt();
  const loaded = { binding, control, restriction, registrations, observations, origin, capability };
  if (control.recovery_generation_id !== null) await checkedRecovery(txn, control.recovery_generation_id, loaded, ctx);
  else await noRecords(txn, ['inventory:recovery:', 'inventory:cut:', 'inventory:cut-head:', 'inventory:progress:'], ctx);
  ctx.gate.check(); return loaded;
}
async function quarantine(txn, loaded, reason, marker, ctx) {
  if (loaded.control.state === 'quarantined') return deny('serving_quarantined');
  const control = { ...loaded.control, state: 'quarantined', quarantine: { reason, detected_at: clock(ctx.now), observed_marker_hash: await ctx.gate.hash(canonical(marker)) } };
  await put(txn, { [CONTROL_KEY]: control }, deny('serving_quarantined'), ctx.gate);
  return deny('serving_quarantined');
}
async function requireServing(txn, loaded, marker, generation, ctx) {
  const c = loaded.control;
  if (generation !== c.writer_generation_id) return deny('writer_generation_stale');
  if (c.state === 'quarantined') return deny('serving_quarantined');
  if (c.state === 'pending') {
    const pending = await plan(txn, c.pending_operation_id, undefined, loaded.binding, ctx);
    if (equal(marker, c.marker) || equal(marker, pending.plan.next)) return deny('operation_pending');
    return quarantine(txn, loaded, 'marker_mismatch', marker, ctx);
  }
  if (!equal(marker, c.marker)) return quarantine(txn, loaded, 'marker_mismatch', marker, ctx);
  if (!equal(marker.cursor, headView(loaded.restriction))) return quarantine(txn, loaded, 'journal_advanced', marker, ctx);
  return null;
}
async function appendRecord(txn, chain, payload, meta, time, ctx) {
  if (meta.sequence >= Number.MAX_SAFE_INTEGER) fail(503, 'inventory_sequence_exhausted');
  const record = { version: 1, protocol: INVENTORY_PROTOCOL, project_id: PROJECT_ID, database_id: meta.database_id,
    incarnation_id: meta.incarnation_id, chain, sequence: meta.sequence + 1, previous_hash: meta.hash,
    payload_hash: await ctx.gate.hash(canonical(payload)), payload: copy(payload), recorded_at: time };
  record.hash = await receiptHash(record, ctx); bounded(record, recordLimit(record));
  return { record, meta: { ...meta, sequence: record.sequence, hash: record.hash, recorded_at: time } };
}

export async function upgradeInventory(storage, value, options) {
  if (options?.format===3) fail(404, 'route_unavailable');
  envelope(value, ['upgrade_id', 'expected', 'expected_control_hash', 'coverage_anchor_hash'], 'inventory_upgrade_invalid');
  if (!uuid(value.upgrade_id) || !digest(value.expected_control_hash) || !digest(value.coverage_anchor_hash)) fail(400, 'inventory_upgrade_invalid');
  const expected = validateMarker(value.expected), ctx = context(options), requestHash = await ctx.gate.hash(canonical(value));
  return transact(storage, ctx, async txn => {
    const receiptKey = 'inventory:upgrade:' + value.upgrade_id, prior = await ctx.gate.wait(txn.get(receiptKey));
    if (prior !== undefined) {
      if (!exact(prior, ['version', 'project_id', 'upgrade_id', 'input_hash', 'old_control_hash', 'writer_generation_id', 'registration_head', 'observation_head', 'recorded_at', 'hash']) ||
          prior.version !== 1 || prior.project_id !== PROJECT_ID || prior.upgrade_id !== value.upgrade_id || !digest(prior.input_hash) || !uuid(prior.writer_generation_id) || !positive(prior.recorded_at)) corrupt();
      const { hash, ...content } = prior;
      if (hash !== await hashContent('inventory-upgrade-v1', content, ctx.gate)) corrupt();
      if (prior.input_hash !== requestHash) fail(409, 'inventory_upgrade_conflict');
      const loaded = await load(txn, ctx);
      if (loaded.control.upgrade_id !== value.upgrade_id || loaded.control.upgrade_receipt_hash !== prior.hash) corrupt();
      return { ...view(loaded.control), upgrade: prior };
    }
    const raw = await ctx.gate.wait(txn.get(CONTROL_KEY));
    if (!raw) fail(409, 'control_uninitialized');
    if (raw.version === 2) fail(409, 'inventory_upgrade_conflict');
    const old = await ctx.gate.wait(loadV1Control(txn)), binding = await ctx.gate.wait(checkedV1Binding(txn));
    if (old.state !== 'serving' || old.pending_operation_id !== null || old.recovery_generation_id !== null) fail(409, 'inventory_upgrade_not_serving');
    if (!equal(expected, old.marker) || await ctx.gate.hash(canonical(old)) !== value.expected_control_hash) fail(409, 'inventory_upgrade_conflict');
    const restriction = await ctx.gate.wait(loadHead(txn));
    if (!equal(expected.cursor, headView(restriction))) fail(409, 'inventory_upgrade_conflict');
    await noRecords(txn, ['inventory:', 'control-archive:'], ctx);
    const registrations = await genesis(binding, 'registrations', ctx.gate), observations = await genesis(binding, 'observations', ctx.gate);
    const writerGeneration = crypto.randomUUID();
    const content = { version: 1, project_id: PROJECT_ID, upgrade_id: value.upgrade_id, input_hash: requestHash,
      old_control_hash: value.expected_control_hash, writer_generation_id: writerGeneration,
      registration_head: headView(registrations), observation_head: headView(observations),
      recorded_at: clock(ctx.now, Math.max(binding.created_at, restriction.recorded_at)) };
    const receipt = { ...content, hash: await hashContent('inventory-upgrade-v1', content, ctx.gate) };
    const control = { ...old, version: 2, writer_generation_id: writerGeneration, minimum_operation_version: 2, inventory_protocol: 1,
      registration_head: headView(registrations), observation_head: headView(observations), coverage_anchor_hash: value.coverage_anchor_hash,
      upgrade_id: value.upgrade_id, upgrade_receipt_hash: receipt.hash, upgrade_control_hash: value.expected_control_hash };
    return put(txn, { ['control-archive:' + value.upgrade_id]: old, [receiptKey]: receipt, [CONTROL_KEY]: control,
      [metaKey('registrations')]: registrations, [metaKey('observations')]: observations }, { ...view(control), upgrade: receipt }, ctx.gate);
  });
}
/** Explicit f2-to-f3 capability switch. No bootstrap or recovery clearance. */
export async function upgradeInventoryCapability(storage,value,options={}) {
  if (!Number.isInteger(options.pageLimit ?? 1) || (options.pageLimit ?? 1) < 1 || (options.pageLimit ?? 1) > 8) fail(503, 'inventory_configuration_invalid');
  if(!exact(value,['version','project_id','capability_id','expected_marker','expected_control_hash','expected_restriction_head','expected_registration_head','expected_observation_head'])||
     value.version!==3||value.project_id!==PROJECT_ID||!uuid(value.capability_id)||!digest(value.expected_control_hash))fail(400,'inventory_capability_invalid');
  value=freeze(copy(value));
  const marker=validateMarker(value.expected_marker);for(const head of [value.expected_restriction_head,value.expected_registration_head,value.expected_observation_head])cursor(head);
  const ctx=context({...options,format:2}),inputHash=await ctx.gate.hash(canonical(value));
  return transact(storage,ctx,async txn=>{
    const existing=await ctx.gate.wait(txn.get(capKey(value.capability_id)));
    if(existing!==undefined){
      const current=await ctx.gate.wait(txn.get(CONTROL_KEY));if(current?.version!==3||current.capability_id!==value.capability_id)fail(409,'inventory_capability_conflict');
      const loaded=await load(txn,{...ctx,format:3});if(loaded.capability.cap.input_hash!==inputHash)fail(409,'inventory_capability_conflict');
      return {...view(loaded.control),capability:loaded.capability.cap};
    }
    const loaded=await load(txn,ctx),old=loaded.control;
    if(old.state!=='serving'||old.pending_operation_id!==null||old.recovery_generation_id!==null||old.quarantine!==null)fail(409,'inventory_capability_not_serving');
    if(!equal(marker,old.marker)||!equal(value.expected_restriction_head,headView(loaded.restriction))||
       !equal(value.expected_restriction_head,old.marker.cursor)||!equal(value.expected_registration_head,old.registration_head)||
       !equal(value.expected_observation_head,old.observation_head)||value.expected_control_hash!==await ctx.gate.hash(canonical(old)))fail(409,'inventory_capability_conflict');
    if(await ctx.gate.wait(txn.get(capArchiveKey(value.capability_id)))!==undefined)corrupt();
    await noRecords(txn,['inventory:capability:','inventory:capability-archive:','inventory:writer-generation:'],ctx);
    const lastCommit=await ctx.gate.wait(txn.get(commitKey(old.marker.checkpoint.revision)));
    if(!lastCommit||!positive(lastCommit.committed_at))corrupt();
    const generation=crypto.randomUUID();if(generation===old.writer_generation_id)corrupt();
    const content={version:1,project_id:PROJECT_ID,capability_id:value.capability_id,input_hash:inputHash,old_control_hash:value.expected_control_hash,
      old_writer_generation_id:old.writer_generation_id,new_writer_generation_id:generation,marker:copy(old.marker),
      restriction_head:headView(loaded.restriction),registration_head:copy(old.registration_head),observation_head:copy(old.observation_head),
      old_upgrade_id:old.upgrade_id,old_upgrade_receipt_hash:old.upgrade_receipt_hash,old_upgrade_control_hash:old.upgrade_control_hash,
      coverage_anchor_hash:old.coverage_anchor_hash,recorded_at:clock(ctx.now,Math.max(loaded.restriction.recorded_at,loaded.registrations.recorded_at,loaded.observations.recorded_at,lastCommit.committed_at,loaded.origin.recorded_at))};
    const cap={...content,hash:await hashContent('inventory-capability-v1',content,ctx.gate)};bounded(cap,2048);
    const control={...old,version:3,writer_generation_id:generation,capability_id:value.capability_id,capability_receipt_hash:cap.hash,
      capability_archive_hash:value.expected_control_hash,capability_version:3,minimum_descriptor_version:2,minimum_link_version:2};
    const gen={version:1,project_id:PROJECT_ID,writer_generation_id:generation,capability_id:value.capability_id,capability_hash:cap.hash};
    return put(txn,{[capArchiveKey(value.capability_id)]:old,[capKey(value.capability_id)]:cap,[generationKey(generation)]:gen,[CONTROL_KEY]:control},
      {...view(control),capability:cap},ctx.gate);
  });
}
export async function readInventoryControl(storage, options) {
  const ctx = context(options); return transact(storage, ctx, async txn => view((await load(txn, ctx)).control));
}
export async function admitInventory(storage, value, options) {
  envelope(value, ['marker', 'writer_generation_id', 'operation_version', 'inventory_protocol'], 'inventory_admission_invalid');
  if (!uuid(value.writer_generation_id) || value.operation_version !== 2 || value.inventory_protocol !== 1) fail(409, 'protocol_version_unsupported');
  if (options?.format===3) value=freeze(copy(value));
  const marker = validateMarker(value.marker);
  const ctx = context(options);
  return finish(await transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), denied = await requireServing(txn, loaded, marker, value.writer_generation_id, ctx);
    return denied ?? { ...view(loaded.control), admitted: true };
  }));
}
async function targetWrite(txn, id, descriptorHash, binding, ctx, { committed = false, control } = {}) {
  const index = await ctx.gate.wait(txn.get(writeKey(id)));
  if (index === undefined) fail(409, 'inventory_target_unknown');
  if (!plain(index) || index.write_id !== id || !positive(index.sequence) || !digest(index.hash) || !digest(index.plan_hash)) corrupt();
  const record = await checkedRecord(txn, 'registrations', index.sequence, binding, ctx);
  if (record.payload.entry_kind !== 'write' || record.payload.item.write_id !== id || record.payload.item_hash !== descriptorHash) fail(409, 'inventory_target_conflict');
  const operation = await plan(txn, index.operation_id, index.plan_hash, binding, ctx);
  if (!operation || operation.plan.version !== 2 || operation.plan.resources.length !== 1 || !equal(operation.plan.resources[0], record.payload.item)) corrupt();
  if (committed && (await operationView(txn, operation, control, ctx)).status !== 'committed') fail(409, 'inventory_target_pending');
  return { index, record, operation, item: record.payload.item };
}
function sameTarget(item, target) {
  return item.owner_id === target.owner_id && item.asset_id === target.asset_id && item.asset_version === target.asset_version &&
    (item.bucket === undefined || item.bucket === target.bucket && item.object_key === target.object_key);
}
async function keyOwner(txn, item, ctx) {
  const hash = await keyHash(item, ctx.gate), owner = await ctx.gate.wait(txn.get('inventory:key-owner:' + hash));
  if (!exact(owner, ['version', 'project_id', 'bucket', 'object_key', 'write_id', 'descriptor_hash', 'sequence', 'hash']) || owner.version !== 1 ||
      owner.project_id !== PROJECT_ID || owner.bucket !== item.bucket || owner.object_key !== item.object_key || !uuid(owner.write_id) ||
      !digest(owner.descriptor_hash) || !positive(owner.sequence) || !digest(owner.hash)) corrupt();
  return { hash, owner };
}
async function retiredKey(txn, target, ctx) {
  const { hash, owner } = await keyOwner(txn, target.item, ctx), retired = await ctx.gate.wait(txn.get('inventory:key-retired:' + hash));
  if (owner.write_id !== target.item.write_id || owner.descriptor_hash !== target.record.payload.item_hash || owner.sequence !== target.record.sequence || owner.hash !== target.record.hash) corrupt();
  if (retired !== undefined && (!exact(retired, ['version', 'project_id', 'bucket', 'object_key', 'target_write_id', 'target_descriptor_hash', 'delete_write_id', 'delete_operation_id', 'sequence', 'hash']) ||
      retired.version !== 1 || retired.project_id !== PROJECT_ID || retired.bucket !== target.item.bucket || retired.object_key !== target.item.object_key ||
      retired.target_write_id !== target.item.write_id || retired.target_descriptor_hash !== target.record.payload.item_hash ||
      !uuid(retired.delete_write_id) || !uuid(retired.delete_operation_id) || !positive(retired.sequence) || !digest(retired.hash))) corrupt();
  return { hash, owner, retired };
}
export async function prepareInventory(storage, raw, options) {
  const ctx = context(options), input = ctx.format===3 ? freeze(prepareHistory(raw)) : validatePrepareV2(raw);
  if(ctx.format===3 && (input.resources.some(item=>item.version!==2||item.action!=='put'||item.kind!=='direct-source') || input.links.some(item=>item.version!==2||item.relation!=='asset-source'))) fail(409,'inventory_capability_unsupported');
  return finish(await transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx);
    if (ctx.format===3 && input.writer_generation_id!==loaded.control.writer_generation_id) return deny('writer_generation_stale');
    if (ctx.format===3 && loaded.control.state==='quarantined') return deny('serving_quarantined');
    if (ctx.format===3 && loaded.control.state==='pending' && loaded.control.pending_operation_id!==input.operation_id) return deny('operation_pending');
    const existing = await plan(txn, input.operation_id, undefined, loaded.binding, ctx);
    if (existing) {
      if (existing.plan.version !== 2) fail(409, 'operation_version_conflict');
      if (!equal(input, planInput(existing.plan))) fail(409, 'operation_conflict');
      return { ...view(loaded.control), operation: await operationView(txn, existing, loaded.control, ctx) };
    }
    const denied = await requireServing(txn, loaded, input.expected, input.writer_generation_id, ctx); if (denied) return denied;
    if (loaded.control.marker.checkpoint.revision >= Number.MAX_SAFE_INTEGER || input.events.length > Number.MAX_SAFE_INTEGER - loaded.restriction.sequence) fail(503, 'journal_sequence_exhausted');
    const item = input.resources[0] ?? input.links[0]; let target, key, retirement;
    if (input.resources.length) {
      if (await ctx.gate.wait(txn.get(writeKey(item.write_id))) !== undefined) fail(409, 'inventory_write_id_conflict');
      key = await keyHash(item, ctx.gate);
      if (item.action === 'put') {
        if (await ctx.gate.wait(txn.get('inventory:key-owner:' + key)) !== undefined) fail(409, 'inventory_key_owned');
        if (await ctx.gate.wait(txn.get('inventory:key-retired:' + key)) !== undefined) fail(409, 'inventory_key_retired');
      } else {
        target = await targetWrite(txn, item.payload.target_write_id, item.payload.target_descriptor_hash, loaded.binding, ctx);
        if (target.item.action !== 'put' || !sameTarget(item, target.item) || item.payload.expected_sha256 !== target.item.payload.sha256 ||
            item.payload.expected_byte_size !== target.item.payload.byte_size) fail(409, 'inventory_target_conflict');
        retirement = await retiredKey(txn, target, ctx);
        if (retirement.retired !== undefined) fail(409, 'inventory_key_retired');
      }
    } else if (input.links.length) {
      target = await targetWrite(txn, item.target_write_id, item.target_descriptor_hash, loaded.binding, ctx, { committed: true, control: loaded.control });
      if (target.item.action !== 'put' || !sameTarget(item, target.item) ||
          (item.relation === 'upload-chunk' ? target.item.kind !== 'upload-chunk' || item.offset_bytes !== target.item.payload.offset_bytes : target.item.kind === 'upload-chunk')) fail(409, 'inventory_target_conflict');
      if ((await retiredKey(txn, target, ctx)).retired !== undefined) fail(409, 'inventory_key_retired');
      if(ctx.format===3){if(target.item.version!==2)fail(409,'inventory_capability_unsupported');await ctx.gate.wait(validateD2LinkTarget(item,target.item));}
      if (await ctx.gate.wait(txn.get(linkKey(input.operation_id))) !== undefined) corrupt();
    }
    const priorCommit = await ctx.gate.wait(txn.get(commitKey(loaded.control.marker.checkpoint.revision)));
    const time = clock(ctx.now, Math.max(loaded.restriction.recorded_at, loaded.registrations.recorded_at, loaded.observations.recorded_at, priorCommit.committed_at));
    const receipts = [];
    for (const event of input.events) { ctx.gate.check(); receipts.push(await ctx.gate.wait(appendEventTransaction(txn, event, await ctx.gate.hash(canonical(event)), () => time, { manifest: true }))); }
    const restrictionCursor = receipts.length ? headView(receipts.at(-1)) : input.expected.cursor;
    const before = headView(loaded.registrations), inventoryReceipts = []; let after = before, newMeta;
    if (item) {
      const appended = await appendRecord(txn, 'registrations', { entry_kind: input.resources.length ? 'write' : 'link', operation_id: input.operation_id,
        input_hash: input.input_hash, ordinal: 0, item_hash: await ctx.gate.hash(canonical(item)), item }, loaded.registrations, time, ctx);
      inventoryReceipts.push(appended.record); after = headView(appended.record); newMeta = appended.meta;
    }
    const next = { database_id: input.expected.database_id, incarnation_id: input.expected.incarnation_id,
      checkpoint: { revision: input.expected.checkpoint.revision + 1, hash: await checkpoint(input, restrictionCursor, before, after, inventoryReceipts, ctx) }, cursor: restrictionCursor };
    const p = { ...input, next, prepared_at: time, receipts, registration_before: before, registration_after: after, inventory_receipts: inventoryReceipts };
    const operation = { plan: p, plan_hash: await ctx.gate.hash(canonical(p)) };
    bounded(operation, LIMITS.response, 'inventory_response_too_large', 503);
    const pending = { ...loaded.control, state: 'pending', pending_operation_id: input.operation_id, registration_head: after };
    const values = { [planKey(input.operation_id)]: operation, [prepareKey(next.checkpoint.revision)]: { operation_id: input.operation_id, plan_hash: operation.plan_hash }, [CONTROL_KEY]: pending };
    if (item) {
      const r = inventoryReceipts[0], common = { version: 1, project_id: PROJECT_ID };
      values[recordKey('registrations', r.sequence)] = r; values[metaKey('registrations')] = newMeta;
      if (input.resources.length) {
        values[writeKey(item.write_id)] = { ...common, write_id: item.write_id, operation_id: input.operation_id, plan_hash: operation.plan_hash,
          descriptor_hash: r.payload.item_hash, sequence: r.sequence, hash: r.hash, action: item.action };
        if (item.action === 'put') values['inventory:key-owner:' + key] = { ...common, bucket: item.bucket, object_key: item.object_key,
          write_id: item.write_id, descriptor_hash: r.payload.item_hash, sequence: r.sequence, hash: r.hash };
        else values['inventory:key-retired:' + key] = { ...common, bucket: item.bucket, object_key: item.object_key,
          target_write_id: target.item.write_id, target_descriptor_hash: target.record.payload.item_hash,
          delete_write_id: item.write_id, delete_operation_id: input.operation_id, sequence: r.sequence, hash: r.hash };
      } else values[linkKey(input.operation_id)] = { ...common, operation_id: input.operation_id, plan_hash: operation.plan_hash,
        item_hash: r.payload.item_hash, sequence: r.sequence, hash: r.hash };
    }
    return put(txn, values, { ...view(pending), operation: { ...operation, status: 'pending', committed_at: null } }, ctx.gate);
  }));
}
export async function lookupInventoryOperation(storage, id, options) {
  if (!uuid(id)) fail(400, 'operation_invalid'); const ctx = context(options);
  return transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), operation = await plan(txn, id, undefined, loaded.binding, ctx);
    if (!operation) fail(404, 'operation_not_found');
    return { ...view(loaded.control), operation: await operationView(txn, operation, loaded.control, ctx) };
  });
}
export async function acknowledgeInventory(storage, id, value, options) {
  envelope(value, ['plan_hash', 'marker', 'writer_generation_id'], 'acknowledgement_invalid');
  if (!uuid(id) || !digest(value.plan_hash) || !uuid(value.writer_generation_id)) fail(400, 'acknowledgement_invalid');
  if (options?.format===3) value=freeze(copy(value));
  const marker = validateMarker(value.marker), ctx = context(options);
  return finish(await transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), operation = await plan(txn, id, undefined, loaded.binding, ctx);
    if (!operation) fail(404, 'operation_not_found');
    if (operation.plan.version !== 2) fail(409, 'operation_version_conflict');
    if (value.writer_generation_id !== operation.plan.writer_generation_id) return deny('writer_generation_stale');
    if (ctx.format===3 && loaded.control.writer_generation_id!==value.writer_generation_id) return deny('writer_generation_stale');
    if (ctx.format===3 && loaded.control.state==='quarantined') return deny('serving_quarantined');
    if (ctx.format===3 && loaded.control.state==='pending' && loaded.control.pending_operation_id!==id) return deny('operation_pending');
    if (value.plan_hash !== operation.plan_hash || !equal(marker, operation.plan.next)) return quarantine(txn, loaded, 'acknowledgement_mismatch', marker, ctx);
    const prior = await operationView(txn, operation, loaded.control, ctx);
    // Historical exact receipt lookup never rewinds a marker or clears quarantine.
    if (prior.status === 'committed') return { ...view(loaded.control), operation: prior };
    if (loaded.control.writer_generation_id !== value.writer_generation_id) return deny('writer_generation_stale');
    if (loaded.control.state === 'quarantined') return deny('serving_quarantined');
    if (loaded.control.state !== 'pending' || loaded.control.pending_operation_id !== id || !equal(loaded.control.marker, operation.plan.expected) ||
        !equal(marker.cursor, headView(loaded.restriction)) || !equal(loaded.control.registration_head, operation.plan.registration_after)) return quarantine(txn, loaded, 'acknowledgement_mismatch', marker, ctx);
    const time = clock(ctx.now, operation.plan.prepared_at), serving = { ...loaded.control, state: 'serving', marker, pending_operation_id: null };
    const commit = { version: 2, project_id: PROJECT_ID, marker, operation_id: id, plan_hash: operation.plan_hash,
      registration_after: operation.plan.registration_after, writer_generation_id: operation.plan.writer_generation_id, committed_at: time };
    return put(txn, { [commitKey(marker.checkpoint.revision)]: commit, [CONTROL_KEY]: serving },
      { ...view(serving), operation: { ...operation, status: 'committed', committed_at: time } }, ctx.gate);
  }));
}
export async function dispatchInventory(storage, value, options) {
  envelope(value, ['marker', 'writer_generation_id', 'write_id', 'descriptor_hash', 'plan_hash'], 'inventory_dispatch_invalid');
  if (!uuid(value.writer_generation_id) || !uuid(value.write_id) || !digest(value.descriptor_hash) || !digest(value.plan_hash)) fail(400, 'inventory_dispatch_invalid');
  if (options?.format===3) value=freeze(copy(value));
  const marker = validateMarker(value.marker), ctx = context(options);
  return finish(await transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), denied = await requireServing(txn, loaded, marker, value.writer_generation_id, ctx); if (denied) return denied;
    const target = await targetWrite(txn, value.write_id, value.descriptor_hash, loaded.binding, ctx, { committed: true, control: loaded.control });
    if (target.operation.plan_hash !== value.plan_hash || target.item.writer_generation_id !== value.writer_generation_id) fail(409, 'inventory_dispatch_conflict');
    if(ctx.format===3&&(target.item.version!==2||target.item.action!=='put'||target.item.kind!=='direct-source'))fail(409,'inventory_capability_unsupported');
    if (target.item.action === 'put') {
      if ((await retiredKey(txn, target, ctx)).retired !== undefined) fail(409, 'inventory_key_retired');
    } else {
      const putTarget = await targetWrite(txn, target.item.payload.target_write_id, target.item.payload.target_descriptor_hash, loaded.binding, ctx);
      const { retired } = await retiredKey(txn, putTarget, ctx);
      if (!retired || retired.delete_write_id !== target.item.write_id || retired.delete_operation_id !== target.item.operation_id ||
          retired.sequence !== target.record.sequence || retired.hash !== target.record.hash) corrupt();
    }
    return { ...view(loaded.control), dispatch_admitted: true, write_id: value.write_id, descriptor_hash: value.descriptor_hash,
      plan_hash: value.plan_hash, remote_terminal_proof: false, application_authority_required: true };
  }));
}
async function observationDependencies(txn, input, binding, control, ctx, registrationLimit) {
  const index = await ctx.gate.wait(txn.get(writeKey(input.write_id)));
  if (!plain(index) || !digest(index.descriptor_hash)) fail(409, 'inventory_target_unknown');
  const target = await targetWrite(txn, input.write_id, index.descriptor_hash, binding, ctx);
  if (target.record.hash !== input.registration_hash || target.operation.plan_hash !== input.plan_hash ||
      registrationLimit !== undefined && target.record.sequence > registrationLimit) fail(409, 'inventory_observation_conflict');
  if (input.kind === 'put-reply' && target.item.action !== 'put' || input.kind === 'delete-reply' && target.item.action !== 'delete') fail(409, 'inventory_observation_conflict');
  if (target.item.action === 'delete') {
    const original = await targetWrite(txn, target.item.payload.target_write_id, target.item.payload.target_descriptor_hash, binding, ctx);
    if (original.item.action !== 'put' || !sameTarget(target.item, original.item) || registrationLimit !== undefined && original.record.sequence > registrationLimit) corrupt();
  }
  if (input.kind === 'publication') {
    if (target.item.action !== 'put') fail(409, 'inventory_observation_conflict');
    const publication = await plan(txn, input.result.publication_operation_id, input.result.publication_plan_hash, binding, ctx);
    if (!publication || publication.plan.version !== 2 || publication.plan.links.length !== 1 ||
        (await operationView(txn, publication, control, ctx)).status !== 'committed') fail(409, 'inventory_publication_uncommitted');
    const link = publication.plan.links[0];
    if (link.target_write_id !== target.item.write_id || link.target_descriptor_hash !== target.record.payload.item_hash || !sameTarget(link, target.item) ||
        registrationLimit !== undefined && publication.plan.registration_after.sequence > registrationLimit) fail(409, 'inventory_observation_conflict');
    if(link.version===2){if(target.item.version!==2)corrupt();await persistedAsync(() => validateD2LinkTarget(link,target.item),ctx.gate);}
  }
  return target;
}
/** Separately authenticated telemetry only. It never admits a writer or proves
 * that a provider call was dispatched or has reached a terminal state. */
export async function observeHistoricalReply(storage,value,options={}) {
  if(!exact(value,['version','project_id','capability_id','original_writer_generation_id','observation'])||value.version!==3||value.project_id!==PROJECT_ID||
     !uuid(value.capability_id)||!uuid(value.original_writer_generation_id))fail(400,'inventory_late_observation_invalid');
  value=freeze(copy(value));
  const input=validateObservation(value.observation);
  if(!['put-reply','delete-reply'].includes(input.kind))fail(400,'inventory_late_observation_invalid');
  const ctx=context({...options,format:3}),payloadHash=await ctx.gate.hash(canonical(input));
  return transact(storage,ctx,async txn=>{
    const loaded=await load(txn,ctx),cap=loaded.capability.cap;
    if(value.capability_id!==cap.capability_id||value.original_writer_generation_id!==cap.old_writer_generation_id)fail(409,'inventory_late_observation_conflict');
    const index=await ctx.gate.wait(txn.get(writeKey(input.write_id)));
    if(!plain(index)||!digest(index.descriptor_hash))fail(409,'inventory_target_unknown');
    const target=await targetWrite(txn,input.write_id,index.descriptor_hash,loaded.binding,ctx,{committed:true,control:loaded.control});
    if(target.item.version!==1||target.item.writer_generation_id!==value.original_writer_generation_id||target.record.hash!==input.registration_hash||
       target.operation.plan_hash!==input.plan_hash||target.record.sequence>cap.registration_head.sequence||
       target.operation.plan.next.checkpoint.revision>cap.marker.checkpoint.revision||
       (input.kind==='put-reply'?target.item.action!=='put':target.item.action!=='delete'))fail(409,'inventory_late_observation_conflict');
    if(target.item.action==='delete'){
      const original=await targetWrite(txn,target.item.payload.target_write_id,target.item.payload.target_descriptor_hash,loaded.binding,ctx,{committed:true,control:loaded.control});
      if(original.item.version!==1||original.item.action!=='put'||!sameTarget(target.item,original.item)||
         target.item.payload.expected_sha256!==original.item.payload.sha256||target.item.payload.expected_byte_size!==original.item.payload.byte_size||
         original.record.sequence>cap.registration_head.sequence||original.operation.plan.next.checkpoint.revision>cap.marker.checkpoint.revision)fail(409,'inventory_late_observation_conflict');
      const {retired}=await retiredKey(txn,original,ctx);
      if(!retired||retired.delete_write_id!==target.item.write_id||retired.delete_operation_id!==target.item.operation_id||
         retired.sequence!==target.record.sequence||retired.hash!==target.record.hash)corrupt();
    }
    const previous=await ctx.gate.wait(txn.get(observationKey(input.observation_id)));
    if(previous!==undefined){
      if(!plain(previous)||!positive(previous.sequence))corrupt();
      const record=await checkedRecord(txn,'observations',previous.sequence,loaded.binding,ctx);
      if(record.payload_hash!==payloadHash)fail(409,'inventory_observation_id_conflict');
      await observationDependencies(txn,record.payload,loaded.binding,loaded.control,ctx,cap.registration_head.sequence);
      return {...view(loaded.control),observation:record};
    }
    await observationDependencies(txn,input,loaded.binding,loaded.control,ctx,cap.registration_head.sequence);
    const time=clock(ctx.now,Math.max(loaded.registrations.recorded_at,loaded.observations.recorded_at));
    const {record,meta}=await appendRecord(txn,'observations',input,loaded.observations,time,ctx);
    const control={...loaded.control,observation_head:headView(record)};
    const own={version:1,project_id:PROJECT_ID,observation_id:input.observation_id,sequence:record.sequence,hash:record.hash,input_hash:payloadHash};
    return put(txn,{[recordKey('observations',record.sequence)]:record,[metaKey('observations')]:meta,
      [observationKey(input.observation_id)]:own,[CONTROL_KEY]:control},{...view(control),observation:record},ctx.gate);
  });
}
export async function observeInventory(storage, raw, options) {
  const ctx = context(options), input = ctx.format===3 ? freeze(validateObservation(raw)) : validateObservation(raw), payloadHash = await ctx.gate.hash(canonical(input));
  return transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), previous = await ctx.gate.wait(txn.get(observationKey(input.observation_id)));
    const currentTarget = async payload => {
      const target = await observationDependencies(txn, payload, loaded.binding, loaded.control, ctx);
      if (ctx.format === 3) {
        if (loaded.control.state !== 'serving' || loaded.control.recovery_generation_id !== null) fail(409, 'inventory_observation_not_serving');
        if (target.item.version !== 2 || target.item.writer_generation_id !== loaded.control.writer_generation_id ||
            (await operationView(txn, target.operation, loaded.control, ctx)).status !== 'committed') fail(409, 'inventory_observation_not_current');
      }
      return target;
    };
    if (previous !== undefined) {
      if (!plain(previous) || !positive(previous.sequence)) corrupt();
      const record = await checkedRecord(txn, 'observations', previous.sequence, loaded.binding, ctx);
      if (record.payload_hash !== payloadHash) fail(409, 'inventory_observation_id_conflict');
      await currentTarget(record.payload);
      return { ...view(loaded.control), observation: record };
    }
    await currentTarget(input);
    const time = clock(ctx.now, Math.max(loaded.registrations.recorded_at, loaded.observations.recorded_at));
    const { record, meta } = await appendRecord(txn, 'observations', input, loaded.observations, time, ctx);
    const control = { ...loaded.control, observation_head: headView(record) };
    const index = { version: 1, project_id: PROJECT_ID, observation_id: input.observation_id, sequence: record.sequence, hash: record.hash, input_hash: payloadHash };
    return put(txn, { [recordKey('observations', record.sequence)]: record, [metaKey('observations')]: meta,
      [observationKey(input.observation_id)]: index, [CONTROL_KEY]: control }, { ...view(control), observation: record }, ctx.gate);
  });
}

const stateFields = ['version', 'project_id', 'recovery_id', 'recovery_generation_id', 'chain', 'cut_id', 'cut_hash',
  'cursor', 'transition_ordinal', 'predecessor_state_hash', 'recorded_at'];
const ackFields = ['request_hash', 'page_hash', 'prior_state_hash', 'next_state_hash', 'cut_id', 'cut_hash', 'after', 'next', 'accepted_at', 'ack_hash'];
const cutFields = ['version', 'project_id', 'recovery_id', 'recovery_generation_id', 'cut_id', 'creation_input_hash', 'cut_ordinal',
  'parent_cut_hash', 'parent_progress', 'prior_marker', 'prior_pending_operation_id', 'old_writer_generation_id', 'fenced_writer_generation_id',
  'restriction_head', 'registration_head', 'observation_head', 'coverage_anchor_hash', 'recorded_at', 'cut_hash'];
async function checkedStateCore(state, stateHash, ctx) {
  if (!exact(state, stateFields) || state.version !== 1 || state.project_id !== PROJECT_ID ||
      ['recovery_id', 'recovery_generation_id', 'cut_id'].some(k => !uuid(state[k])) || !CHAIN_NAMES.includes(state.chain) ||
      !digest(state.cut_hash) || !unsigned(state.transition_ordinal) || !(state.predecessor_state_hash === null || digest(state.predecessor_state_hash)) ||
      !positive(state.recorded_at) || !digest(stateHash)) corrupt();
  persisted(() => cursor(state.cursor)); persisted(() => bounded(state, LIMITS.state));
  if (stateHash !== await hashContent('inventory-enumeration-state-v1', { state }, ctx.gate)) corrupt();
  if (state.transition_ordinal === 0 ? state.predecessor_state_hash !== null : state.predecessor_state_hash === null) corrupt();
}
async function checkedCutShallow(txn, recovery, id, ctx) {
  const cut = await ctx.gate.wait(txn.get(cutKey(recovery, id)));
  if (!exact(cut, cutFields) || cut.version !== 1 || cut.project_id !== PROJECT_ID || cut.recovery_id !== recovery || cut.cut_id !== id ||
      !uuid(cut.recovery_id) || !uuid(cut.recovery_generation_id) || !uuid(cut.cut_id) || !digest(cut.creation_input_hash) ||
      !unsigned(cut.cut_ordinal) || !nullableUuid(cut.prior_pending_operation_id) || !uuid(cut.old_writer_generation_id) ||
      !uuid(cut.fenced_writer_generation_id) || cut.old_writer_generation_id === cut.fenced_writer_generation_id || !digest(cut.coverage_anchor_hash) ||
      !positive(cut.recorded_at) || !digest(cut.cut_hash)) corrupt();
  persisted(() => bounded(cut, LIMITS.cut)); persisted(() => validateMarker(cut.prior_marker));
  for (const name of ['restriction_head', 'registration_head', 'observation_head']) persisted(() => cursor(cut[name]));
  if (cut.restriction_head.sequence === 0 && cut.restriction_head.hash !== GENESIS_HASH) corrupt();
  const { cut_hash, ...content } = cut;
  if (cut_hash !== await ctx.gate.hash(canonical(content))) corrupt();
  if (cut.cut_ordinal === 0) { if (cut.parent_cut_hash !== null || cut.parent_progress !== null) corrupt(); }
  else {
    if (!digest(cut.parent_cut_hash) || !exact(cut.parent_progress, CHAIN_NAMES)) corrupt();
    for (const chain of CHAIN_NAMES) {
      const capsule = cut.parent_progress[chain];
      if (!exact(capsule, ['state', 'state_hash', 'carry_prefix']) || typeof capsule.carry_prefix !== 'boolean') corrupt();
      await checkedStateCore(capsule.state, capsule.state_hash, ctx);
      if (capsule.state.chain !== chain || capsule.state.recovery_id !== recovery || capsule.state.recovery_generation_id !== cut.recovery_generation_id ||
          capsule.state.cut_hash !== cut.parent_cut_hash) corrupt();
    }
    if (cut.parent_progress.registrations.state.cut_id !== cut.parent_progress.observations.state.cut_id) corrupt();
  }
  return cut;
}
async function checkedCut(txn, recovery, id, binding, ctx) {
  const cut = await checkedCutShallow(txn, recovery, id, ctx);
  if (cut.prior_marker.database_id !== binding.database_id || cut.prior_marker.incarnation_id !== binding.initial_marker.incarnation_id) corrupt();
  if (!ctx.heads || cut.restriction_head.sequence > ctx.heads.restriction.sequence ||
      cut.registration_head.sequence > ctx.heads.registrations.sequence || cut.observation_head.sequence > ctx.heads.observations.sequence) corrupt();
  if (cut.restriction_head.sequence > 0 && (await ctx.gate.wait(checkedReceipt(txn, cut.restriction_head.sequence))).hash !== cut.restriction_head.hash) corrupt();
  if (cut.parent_progress) {
    const parent = await checkedCutShallow(txn, recovery, cut.parent_progress.registrations.state.cut_id, ctx);
    if (parent.cut_hash !== cut.parent_cut_hash || parent.cut_ordinal + 1 !== cut.cut_ordinal ||
        parent.recovery_generation_id !== cut.recovery_generation_id || parent.fenced_writer_generation_id !== cut.fenced_writer_generation_id ||
        parent.old_writer_generation_id !== cut.old_writer_generation_id || parent.coverage_anchor_hash !== cut.coverage_anchor_hash ||
        !equal(parent.prior_marker, cut.prior_marker) || parent.prior_pending_operation_id !== cut.prior_pending_operation_id ||
        !equal(parent.registration_head, cut.registration_head) || cut.observation_head.sequence < parent.observation_head.sequence ||
        cut.restriction_head.sequence < parent.restriction_head.sequence || cut.recorded_at < parent.recorded_at ||
        cut.observation_head.sequence === parent.observation_head.sequence && cut.observation_head.hash !== parent.observation_head.hash ||
        cut.restriction_head.sequence === parent.restriction_head.sequence && cut.restriction_head.hash !== parent.restriction_head.hash) corrupt();
    for (const chain of CHAIN_NAMES) {
      const prior = cut.parent_progress[chain].state;
      if (prior.recorded_at > cut.recorded_at) corrupt();
      await checkedCursor(txn, chain, prior.cursor, stateHead({ chain }, parent), binding, ctx);
      await checkedCursor(txn, chain, prior.cursor, stateHead({ chain }, cut), binding, ctx);
    }
  }
  for (const chain of CHAIN_NAMES) await checkedCursor(txn, chain, stateHead({ chain }, cut), stateHead({ chain }, cut), binding, ctx);
  return cut;
}
async function checkedRecovery(txn, id, loaded, ctx) {
  const value = await ctx.gate.wait(txn.get(recoveryKey(id)));
  if (!exact(value, ['version', 'project_id', 'recovery_id', 'generation_id', 'input_hash', 'initial_cut_id', 'initial_cut_hash', 'prior_marker',
      'prior_pending_operation_id', 'old_writer_generation_id', 'fenced_writer_generation_id', 'created_at', 'hash']) ||
      value.version !== 1 || value.project_id !== PROJECT_ID || value.recovery_id !== id || value.generation_id !== id || !uuid(id) ||
      !digest(value.input_hash) || !uuid(value.initial_cut_id) || !digest(value.initial_cut_hash) || !nullableUuid(value.prior_pending_operation_id) ||
      !uuid(value.old_writer_generation_id) || !uuid(value.fenced_writer_generation_id) || value.old_writer_generation_id === value.fenced_writer_generation_id || !positive(value.created_at)) corrupt();
  persisted(() => validateMarker(value.prior_marker));
  const { hash, ...content } = value;
  if (hash !== await hashContent('inventory-recovery-v1', content, ctx.gate) || loaded.control.state !== 'quarantined' ||
      loaded.control.recovery_generation_id !== id || loaded.control.writer_generation_id !== value.fenced_writer_generation_id ||
      value.old_writer_generation_id !== (loaded.capability?.cap.new_writer_generation_id ?? loaded.origin.writer_generation_id) ||
      !equal(loaded.control.marker, value.prior_marker) || loaded.control.pending_operation_id !== value.prior_pending_operation_id) corrupt();
  const initial = await checkedCutShallow(txn, id, value.initial_cut_id, ctx);
  if (initial.cut_hash !== value.initial_cut_hash || initial.creation_input_hash !== value.input_hash || initial.cut_ordinal !== 0 ||
      initial.old_writer_generation_id !== value.old_writer_generation_id || initial.fenced_writer_generation_id !== value.fenced_writer_generation_id ||
      !equal(initial.prior_marker, value.prior_marker) || initial.prior_pending_operation_id !== value.prior_pending_operation_id ||
      initial.coverage_anchor_hash !== loaded.control.coverage_anchor_hash) corrupt();
  return value;
}
async function activeCut(txn, id, loaded, ctx) {
  if (loaded.control.state !== 'quarantined' || loaded.control.recovery_generation_id !== id) fail(409, 'recovery_not_current');
  const recovery = await checkedRecovery(txn, id, loaded, ctx), head = await ctx.gate.wait(txn.get(cutHeadKey(id)));
  if (!exact(head, ['version', 'project_id', 'recovery_id', 'cut_id', 'cut_hash']) || head.version !== 1 || head.project_id !== PROJECT_ID || head.recovery_id !== id ||
      !uuid(head.cut_id) || !digest(head.cut_hash)) corrupt();
  const cut = await checkedCut(txn, id, head.cut_id, loaded.binding, ctx);
  if (cut.cut_hash !== head.cut_hash || cut.recovery_generation_id !== recovery.generation_id ||
      cut.fenced_writer_generation_id !== loaded.control.writer_generation_id || cut.old_writer_generation_id !== recovery.old_writer_generation_id ||
      cut.coverage_anchor_hash !== loaded.control.coverage_anchor_hash || !equal(cut.prior_marker, loaded.control.marker) ||
      cut.prior_pending_operation_id !== loaded.control.pending_operation_id || !equal(cut.registration_head, loaded.control.registration_head) ||
      cut.observation_head.sequence > loaded.control.observation_head.sequence) corrupt();
  return { recovery, cut, head };
}
async function makeState(recovery, chain, cut, selectedCursor, old, time, ctx) {
  if (old && old.state.transition_ordinal >= Number.MAX_SAFE_INTEGER) fail(503, 'inventory_sequence_exhausted');
  const state = { version: 1, project_id: PROJECT_ID, recovery_id: recovery, recovery_generation_id: cut.recovery_generation_id,
    chain, cut_id: cut.cut_id, cut_hash: cut.cut_hash, cursor: { ...selectedCursor }, transition_ordinal: old ? old.state.transition_ordinal + 1 : 0,
    predecessor_state_hash: old ? old.state_hash : null, recorded_at: time };
  bounded(state, LIMITS.state);
  return { state, state_hash: await hashContent('inventory-enumeration-state-v1', { state }, ctx.gate), last_ack: null };
}
async function checkedProgress(txn, id, chain, cut, binding, ctx) {
  const record = await ctx.gate.wait(txn.get(progressKey(id, chain)));
  if (!exact(record, ['state', 'state_hash', 'last_ack'])) corrupt();
  persisted(() => bounded(record, LIMITS.progress)); await checkedStateCore(record.state, record.state_hash, ctx);
  const s = record.state;
  if (s.recovery_id !== id || s.recovery_generation_id !== cut.recovery_generation_id || s.chain !== chain || s.cut_id !== cut.cut_id || s.cut_hash !== cut.cut_hash) corrupt();
  await checkedCursor(txn, chain, s.cursor, stateHead(s, cut), binding, ctx);
  if (record.last_ack === null) {
    const capsule = cut.parent_progress?.[chain], initial = headView(await genesis(binding, chain, ctx.gate));
    if (capsule ? s.transition_ordinal !== capsule.state.transition_ordinal + 1 || s.predecessor_state_hash !== capsule.state_hash ||
        !equal(s.cursor, capsule.carry_prefix ? capsule.state.cursor : initial) :
        s.transition_ordinal !== 0 || s.predecessor_state_hash !== null || !equal(s.cursor, initial)) corrupt();
    if (s.recorded_at !== cut.recorded_at) corrupt();
  } else {
    const ack = record.last_ack;
    if (!exact(ack, ackFields) || ['request_hash', 'page_hash', 'prior_state_hash', 'next_state_hash', 'cut_hash', 'ack_hash'].some(k => !digest(ack[k])) ||
        ack.next_state_hash !== record.state_hash || ack.prior_state_hash !== s.predecessor_state_hash || ack.cut_id !== s.cut_id || ack.cut_hash !== s.cut_hash ||
        ack.accepted_at !== s.recorded_at || !equal(ack.next, s.cursor) || !plain(ack.after) || ack.after.sequence >= ack.next.sequence ||
        ack.next.sequence - ack.after.sequence > LIMITS.page) corrupt();
    persisted(() => cursor(ack.after)); persisted(() => cursor(ack.next)); persisted(() => bounded(ack, LIMITS.ack));
    await checkedCursor(txn, chain, ack.after, stateHead(s, cut), binding, ctx);
    const { ack_hash, ...content } = ack;
    if (ack_hash !== await hashContent('inventory-enumeration-ack-v1', content, ctx.gate)) corrupt();
  }
  return record;
}
function cutHead(recovery, cut) { return { version: 1, project_id: PROJECT_ID, recovery_id: recovery, cut_id: cut.cut_id, cut_hash: cut.cut_hash }; }
async function sealCut(content, ctx) {
  const cut = { ...content, cut_hash: await ctx.gate.hash(canonical(content)) }; bounded(cut, LIMITS.cut); return cut;
}
export async function beginInventoryRecovery(storage, value, options) {
  envelope(value, ['recovery_id', 'cut_id', 'expected', 'writer_generation_id'], 'inventory_recovery_invalid');
  if (!uuid(value.recovery_id) || !uuid(value.cut_id) || !uuid(value.writer_generation_id)) fail(400, 'inventory_recovery_invalid');
  if (options?.format===3) value=freeze(copy(value));
  const marker = validateMarker(value.expected), ctx = context(options), inputHash = await ctx.gate.hash(canonical(value));
  return finish(await transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), c = loaded.control;
    if (c.recovery_generation_id !== null) {
      if (c.recovery_generation_id !== value.recovery_id) fail(409, 'recovery_in_progress');
      const current = await activeCut(txn, value.recovery_id, loaded, ctx);
      if (current.recovery.input_hash !== inputHash) fail(409, 'recovery_conflict');
      return { ...view(c), recovery: current.recovery, cut: await checkedCut(txn, value.recovery_id, current.recovery.initial_cut_id, loaded.binding, ctx), active_cut: current.head, ...(ctx.format===3 ? {immutable_evidence_only:true} : {}) };
    }
    if (value.writer_generation_id !== c.writer_generation_id) return deny('writer_generation_stale');
    if (!equal(marker, c.marker)) return quarantine(txn, loaded, 'marker_mismatch', marker, ctx);
    if (await ctx.gate.wait(txn.get(recoveryKey(value.recovery_id))) !== undefined ||
        await ctx.gate.wait(txn.get(cutKey(value.recovery_id, value.cut_id))) !== undefined ||
        await ctx.gate.wait(txn.get(cutHeadKey(value.recovery_id))) !== undefined) corrupt();
    await noRecords(txn, ['inventory:progress:' + value.recovery_id + ':', 'inventory:cut:' + value.recovery_id + ':'], ctx);
    const time = clock(ctx.now, Math.max(loaded.restriction.recorded_at, loaded.registrations.recorded_at, loaded.observations.recorded_at));
    const generation = crypto.randomUUID();
    if(generation===c.writer_generation_id||loaded.capability&&(generation===loaded.capability.cap.old_writer_generation_id||await ctx.gate.wait(txn.get(generationKey(generation)))!==undefined))corrupt();
    const cut = await sealCut({ version: 1, project_id: PROJECT_ID, recovery_id: value.recovery_id, recovery_generation_id: value.recovery_id,
      cut_id: value.cut_id, creation_input_hash: inputHash, cut_ordinal: 0, parent_cut_hash: null, parent_progress: null,
      prior_marker: c.marker, prior_pending_operation_id: c.pending_operation_id, old_writer_generation_id: c.writer_generation_id,
      fenced_writer_generation_id: generation, restriction_head: headView(loaded.restriction), registration_head: c.registration_head,
      observation_head: c.observation_head, coverage_anchor_hash: c.coverage_anchor_hash, recorded_at: time }, ctx);
    const r = { version: 1, project_id: PROJECT_ID, recovery_id: value.recovery_id, generation_id: value.recovery_id, input_hash: inputHash,
      initial_cut_id: value.cut_id, initial_cut_hash: cut.cut_hash, prior_marker: c.marker, prior_pending_operation_id: c.pending_operation_id,
      old_writer_generation_id: c.writer_generation_id, fenced_writer_generation_id: generation, created_at: time };
    const recovery = { ...r, hash: await hashContent('inventory-recovery-v1', r, ctx.gate) };
    const control = { ...c, state: 'quarantined', writer_generation_id: generation, recovery_generation_id: value.recovery_id,
      quarantine: c.quarantine ?? { reason: 'planned_restore', detected_at: time, observed_marker_hash: await ctx.gate.hash(canonical(marker)) } };
    const values = { [CONTROL_KEY]: control, [recoveryKey(value.recovery_id)]: recovery, [cutKey(value.recovery_id, value.cut_id)]: cut,
      [cutHeadKey(value.recovery_id)]: cutHead(value.recovery_id, cut) };
    for (const chain of CHAIN_NAMES) values[progressKey(value.recovery_id, chain)] = await makeState(value.recovery_id, chain, cut, headView(await genesis(loaded.binding, chain, ctx.gate)), null, time, ctx);
    return put(txn, values, { ...view(control), recovery, cut, active_cut: cutHead(value.recovery_id, cut) }, ctx.gate);
  }));
}
export async function createInventoryCut(storage, id, value, options) {
  envelope(value, ['recovery_id', 'cut_id', 'expected_parent_cut_id', 'expected_parent_cut_hash', 'expected_progress', 'carry_prefix'], 'inventory_cut_invalid');
  if (!uuid(id) || value.recovery_id !== id || !uuid(value.cut_id) || !uuid(value.expected_parent_cut_id) || !digest(value.expected_parent_cut_hash) ||
      !exact(value.expected_progress, CHAIN_NAMES) || CHAIN_NAMES.some(k => !digest(value.expected_progress[k])) ||
      !exact(value.carry_prefix, CHAIN_NAMES) || CHAIN_NAMES.some(k => typeof value.carry_prefix[k] !== 'boolean')) fail(400, 'inventory_cut_invalid');
  if (options?.format===3) value=freeze(copy(value));
  const ctx = context(options), inputHash = await ctx.gate.hash(canonical(value));
  return transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), active = await activeCut(txn, id, loaded, ctx), existing = await ctx.gate.wait(txn.get(cutKey(id, value.cut_id)));
    if (existing !== undefined) {
      const cut = await checkedCut(txn, id, value.cut_id, loaded.binding, ctx);
      if (cut.creation_input_hash !== inputHash) fail(409, 'inventory_cut_conflict');
      return { ...view(loaded.control), cut, active_cut: active.head, immutable_evidence_only: true };
    }
    if (active.head.cut_id !== value.expected_parent_cut_id || active.head.cut_hash !== value.expected_parent_cut_hash) fail(409, 'enumeration_cut_stale');
    if (active.cut.cut_ordinal >= Number.MAX_SAFE_INTEGER) fail(503, 'inventory_sequence_exhausted');
    const old = {}, capsules = {};
    for (const chain of CHAIN_NAMES) {
      old[chain] = await checkedProgress(txn, id, chain, active.cut, loaded.binding, ctx);
      if (old[chain].state_hash !== value.expected_progress[chain]) fail(409, 'enumeration_progress_stale');
      capsules[chain] = { state: old[chain].state, state_hash: old[chain].state_hash, carry_prefix: value.carry_prefix[chain] };
    }
    const time = clock(ctx.now, Math.max(active.cut.recorded_at, loaded.restriction.recorded_at, loaded.observations.recorded_at,
      ...CHAIN_NAMES.map(chain => old[chain].state.recorded_at)));
    const cut = await sealCut({ version: 1, project_id: PROJECT_ID, recovery_id: id, recovery_generation_id: active.recovery.generation_id,
      cut_id: value.cut_id, creation_input_hash: inputHash, cut_ordinal: active.cut.cut_ordinal + 1, parent_cut_hash: active.cut.cut_hash,
      parent_progress: capsules, prior_marker: loaded.control.marker, prior_pending_operation_id: loaded.control.pending_operation_id,
      old_writer_generation_id: active.recovery.old_writer_generation_id, fenced_writer_generation_id: active.recovery.fenced_writer_generation_id,
      restriction_head: headView(loaded.restriction), registration_head: loaded.control.registration_head,
      observation_head: loaded.control.observation_head, coverage_anchor_hash: loaded.control.coverage_anchor_hash, recorded_at: time }, ctx);
    const values = { [cutKey(id, value.cut_id)]: cut, [cutHeadKey(id)]: cutHead(id, cut) };
    for (const chain of CHAIN_NAMES) {
      const selected = value.carry_prefix[chain] ? old[chain].state.cursor : headView(await genesis(loaded.binding, chain, ctx.gate));
      values[progressKey(id, chain)] = await makeState(id, chain, cut, selected, old[chain], time, ctx);
    }
    return put(txn, values, { ...view(loaded.control), cut, active_cut: cutHead(id, cut), immutable_evidence_only: false }, ctx.gate);
  });
}

async function registrationDependencies(txn, record, binding, control, ctx, cut) {
  const p = record.payload, index = await ctx.gate.wait(txn.get(p.entry_kind === 'write' ? writeKey(p.item.write_id) : linkKey(p.operation_id)));
  const own = await plan(txn, p.operation_id, index.plan_hash, binding, ctx);
  if (!own || own.plan.version !== 2 || !equal(own.plan.inventory_receipts[0], record) || record.sequence > cut.registration_head.sequence) corrupt();
  if (p.entry_kind === 'link') {
    const target = await targetWrite(txn, p.item.target_write_id, p.item.target_descriptor_hash, binding, ctx, { committed: true, control });
    if (target.item.action !== 'put' || !sameTarget(p.item, target.item) || target.record.sequence > cut.registration_head.sequence) corrupt();
    if(p.item.version===2){if(target.item.version!==2)corrupt();await persistedAsync(() => validateD2LinkTarget(p.item,target.item),ctx.gate);}
  } else if (p.item.action === 'delete') {
    const target = await targetWrite(txn, p.item.payload.target_write_id, p.item.payload.target_descriptor_hash, binding, ctx);
    if (target.item.action !== 'put' || !sameTarget(p.item, target.item) || target.record.sequence > cut.registration_head.sequence) corrupt();
    if(p.item.version===2){if(target.item.version!==2)corrupt();await persistedAsync(() => validateD2LinkTarget(p.item,target.item),ctx.gate);}
    const retired = (await retiredKey(txn, target, ctx)).retired;
    if (!retired || retired.delete_write_id !== p.item.write_id || retired.sequence !== record.sequence || retired.hash !== record.hash) corrupt();
  } else {
    const { owner } = await keyOwner(txn, p.item, ctx);
    if (owner.write_id !== p.item.write_id || owner.descriptor_hash !== p.item_hash || owner.sequence !== record.sequence || owner.hash !== record.hash) corrupt();
  }
}
async function pageWithin(txn, id, chain, cut, after, limit, loaded, ctx) {
  if (!positive(limit) || limit > ctx.pageLimit || limit > LIMITS.page) fail(400, 'inventory_page_limit_invalid');
  const head = stateHead({ chain }, cut);
  if (after.sequence > head.sequence) fail(409, 'inventory_cursor_ahead');
  await checkedCursor(txn, chain, after, head, loaded.binding, ctx);
  const count = Math.min(limit, head.sequence - after.sequence), rows = count ?
    await ctx.gate.wait(txn.list({ prefix: 'inventory:' + chainTag(chain) + ':', startAfter: recordKey(chain, after.sequence), limit: count })) : new Map();
  if (rows.size !== count) corrupt();
  const records = []; let previous = { ...after };
  for (const [key, value] of rows) {
    const sequence = previous.sequence + 1;
    if (key !== recordKey(chain, sequence)) corrupt();
    const record = await checkedRecord(txn, chain, sequence, loaded.binding, ctx);
    if (!equal(value, record) || record.previous_hash !== previous.hash) corrupt();
    if (chain === 'registrations') await registrationDependencies(txn, record, loaded.binding, loaded.control, ctx, cut);
    else await observationDependencies(txn, record.payload, loaded.binding, loaded.control, ctx, cut.registration_head.sequence);
    previous = headView(record); records.push(record);
  }
  if (previous.sequence === head.sequence && previous.hash !== head.hash) corrupt();
  const page = { protocol: INVENTORY_PROTOCOL, project_id: PROJECT_ID, recovery_id: id, recovery_generation_id: cut.recovery_generation_id,
    cut_id: cut.cut_id, cut_hash: cut.cut_hash, chain, after, head, records, next: previous,
    has_more: previous.sequence < head.sequence, enumeration_at_cut_end: previous.sequence === head.sequence };
  const { records: omit, ...withoutRecords } = page;
  bounded(withoutRecords, LIMITS.pageEnvelope, 'inventory_response_too_large', 503);
  const result = { ...page, page_hash: await ctx.gate.hash(canonical(page)) };
  bounded(result, LIMITS.response, 'inventory_response_too_large', 503); ctx.gate.check(); return result;
}
export async function readInventoryPage(storage, id, chain, value, options) {
  if (!uuid(id) || !exact(value, ['cut_id', 'after', 'limit']) || !uuid(value.cut_id)) fail(400, 'inventory_page_invalid');
  if (options?.format===3) value=freeze(copy(value));
  chainName(chain); const after = cursor(value.after), ctx = context(options);
  return transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx); await activeCut(txn, id, loaded, ctx);
    const cut = await checkedCut(txn, id, value.cut_id, loaded.binding, ctx);
    return pageWithin(txn, id, chain, cut, after, value.limit, loaded, ctx);
  });
}
async function progressView(record, active, ctx) {
  const head = stateHead(record.state, active.cut), atEnd = equal(record.state.cursor, head);
  const content = { protocol: INVENTORY_PROTOCOL, project_id: PROJECT_ID, recovery_id: record.state.recovery_id,
    recovery_generation_id: record.state.recovery_generation_id, chain: record.state.chain, active_cut: active.head,
    head, progress: record, enumeration_at_cut_end: atEnd, clearance_available: false };
  const result = { ...content, response_hash: await ctx.gate.hash(canonical(content)) };
  bounded(result, LIMITS.progressResponse, 'inventory_response_too_large', 503); return result;
}
export async function readInventoryProgress(storage, id, chain, options) {
  if (!uuid(id)) fail(400, 'inventory_progress_invalid'); chainName(chain); const ctx = context(options);
  return transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), active = await activeCut(txn, id, loaded, ctx);
    return progressView(await checkedProgress(txn, id, chain, active.cut, loaded.binding, ctx), active, ctx);
  });
}
export async function acknowledgeInventoryPage(storage, id, value, options) {
  envelope(value, ['recovery_id', 'recovery_generation_id', 'chain', 'cut_id', 'cut_hash', 'expected_state_hash', 'after', 'limit', 'page_hash', 'next'], 'inventory_progress_invalid');
  if (!uuid(id) || value.recovery_id !== id || !uuid(value.recovery_generation_id) || !uuid(value.cut_id) ||
      !digest(value.cut_hash) || !digest(value.expected_state_hash) || !digest(value.page_hash)) fail(400, 'inventory_progress_invalid');
  if (options?.format===3) value=freeze(copy(value));
  chainName(value.chain); const after = cursor(value.after), next = cursor(value.next), ctx = context(options);
  const requestHash = await ctx.gate.hash(canonical(value));
  return transact(storage, ctx, async txn => {
    const loaded = await load(txn, ctx), active = await activeCut(txn, id, loaded, ctx);
    if (value.recovery_generation_id !== active.recovery.generation_id) fail(409, 'recovery_generation_stale');
    if (value.cut_id !== active.head.cut_id || value.cut_hash !== active.head.cut_hash) fail(409, 'enumeration_cut_stale');
    const old = await checkedProgress(txn, id, value.chain, active.cut, loaded.binding, ctx), prior = old.last_ack;
    if (prior?.request_hash === requestHash) {
      if (prior.next_state_hash !== old.state_hash || prior.page_hash !== value.page_hash || prior.prior_state_hash !== value.expected_state_hash ||
          !equal(prior.after, after) || !equal(prior.next, next)) corrupt();
      return { ...await progressView(old, active, ctx), acknowledgement: prior };
    }
    if (value.expected_state_hash !== old.state_hash || !equal(after, old.state.cursor)) fail(409, 'enumeration_progress_stale');
    const page = await pageWithin(txn, id, value.chain, active.cut, after, value.limit, loaded, ctx);
    if (page.page_hash !== value.page_hash || !equal(page.next, next)) fail(409, 'enumeration_page_conflict');
    if (!page.records.length) return { ...await progressView(old, active, ctx), acknowledgement: null };
    const time = clock(ctx.now, old.state.recorded_at), record = await makeState(id, value.chain, active.cut, next, old, time, ctx);
    const content = { request_hash: requestHash, page_hash: value.page_hash, prior_state_hash: old.state_hash, next_state_hash: record.state_hash,
      cut_id: active.cut.cut_id, cut_hash: active.cut.cut_hash, after, next, accepted_at: time };
    const acknowledgement = { ...content, ack_hash: await hashContent('inventory-enumeration-ack-v1', content, ctx.gate) };
    bounded(acknowledgement, LIMITS.ack); record.last_ack = acknowledgement; bounded(record, LIMITS.progress);
    return put(txn, { [progressKey(id, value.chain)]: record }, { ...await progressView(record, active, ctx), acknowledgement }, ctx.gate);
  });
}

export function inventoryRoute(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || request.headers.has('Upgrade')) fail(400, 'transport_invalid');
  const format=url.pathname.startsWith('/v3/')?3:url.pathname.startsWith('/v2/')?2:null;
  if(!format)return null;const path=format===3?'/v2/'+url.pathname.slice(4):url.pathname;
  if(format===3&&path==='/v2/control/capability'){if(url.search)fail(400,'query_invalid');if(request.method!=='POST')fail(405,'method_unavailable');return {kind:'capability',format};}
  if(format===3&&path==='/v2/inventory/late-observations'){if(url.search)fail(400,'query_invalid');if(request.method!=='POST')fail(405,'method_unavailable');return {kind:'late',format};}
  if(format===3&&path==='/v2/control/upgrade')fail(404,'route_unavailable');
  const fixed = { '/v2/control': ['GET', 'control'], '/v2/control/upgrade': ['POST', 'upgrade'], '/v2/admission': ['POST', 'admission'],
    '/v2/operations/prepare': ['POST', 'prepare'], '/v2/inventory/dispatch-admission': ['POST', 'dispatch'],
    '/v2/inventory/observations': ['POST', 'observe'], '/v2/recovery/begin': ['POST', 'begin'] };
  let target;
  if (Object.hasOwn(fixed, path)) { const [method, kind] = fixed[path]; if (request.method !== method) fail(405, 'method_unavailable'); target = { kind }; }
  else {
    let match = /^\/v2\/operations\/([^/]+)(\/acknowledge)?$/.exec(path);
    if (match) {
      if (!uuid(match[1])) fail(404, 'route_unavailable');
      if (request.method !== (match[2] ? 'POST' : 'GET')) fail(405, 'method_unavailable');
      target = { kind: match[2] ? 'acknowledge' : 'lookup', operation_id: match[1] };
    } else {
      match = /^\/v2\/recovery\/([^/]+)\/(cuts|enumeration-progress|inventory\/(registrations|observations))$/.exec(path);
      if (!match || !uuid(match[1])) fail(404, 'route_unavailable');
      target = { recovery_id: match[1] };
      if (match[2] === 'cuts') { if (request.method !== 'POST') fail(405, 'method_unavailable'); target.kind = 'cut'; }
      else if (match[2] === 'enumeration-progress') {
        if (!['GET', 'POST'].includes(request.method)) fail(405, 'method_unavailable'); target.kind = request.method === 'GET' ? 'progress' : 'progress-ack';
        if (target.kind === 'progress') {
          if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('chain').length !== 1) fail(400, 'query_invalid');
          target.chain = chainName(url.searchParams.get('chain')); target.format=format;return target;
        }
      } else {
        if (request.method !== 'GET') fail(405, 'method_unavailable'); target.kind = 'page'; target.chain = match[3];
        const keys = ['cut_id', 'after_sequence', 'after_hash', 'limit'];
        if ([...url.searchParams.keys()].length !== keys.length || keys.some(k => url.searchParams.getAll(k).length !== 1)) fail(400, 'query_invalid');
        const number = x => { if (!/^(0|[1-9][0-9]{0,15})$/.test(x)) fail(400, 'query_invalid'); const n = Number(x); if (!unsigned(n)) fail(400, 'query_invalid'); return n; };
        target.page = { cut_id: url.searchParams.get('cut_id'), after: { sequence: number(url.searchParams.get('after_sequence')), hash: url.searchParams.get('after_hash') }, limit: number(url.searchParams.get('limit')) };
        if (!uuid(target.page.cut_id) || !digest(target.page.after.hash)) fail(400, 'query_invalid');target.format=format;return target;
      }
    }
  }
  if (url.search) fail(400, 'query_invalid');target.format=format;return target;
}

export async function authenticateInventoryRoute(request,env){
  const observer=env?.RESTORE_JOURNAL_OBSERVER_TOKEN,admin=env?.RESTORE_JOURNAL_TOKEN;
  const scoped=new URL(request.url).pathname==='/v3/inventory/late-observations';
  if(observer!==undefined){
    if(typeof observer!=='string'||!/^[!-~]{32,256}$/.test(observer)||typeof admin!=='string'||!/^[!-~]{32,256}$/.test(admin)) fail(503,'inventory_observer_disabled');
    const [observerHash,adminHash]=await Promise.all([sha256(observer),sha256(admin)]);let same=0;
    for(let i=0;i<64;i++)same|=observerHash.charCodeAt(i)^adminHash.charCodeAt(i);
    if(same===0)fail(503,'inventory_observer_disabled');
  }
  if(!scoped)return authenticate(request,env);
  if(env?.SUPABASE_PROJECT_ID!==PROJECT_ID||observer===undefined)fail(503,'inventory_observer_disabled');
  const authorization=request.headers.get('Authorization')??'',match=authorization.length<=263?/^Bearer ([!-~]{32,256})$/.exec(authorization):null;
  const [expected,supplied]=await Promise.all([sha256(observer),sha256(match?.[1]??'')]);let different=0;
  for(let i=0;i<64;i++)different|=expected.charCodeAt(i)^supplied.charCodeAt(i);
  if(different!==0||!match)fail(401,'journal_authentication_required');
}
export async function handleInventoryRequest(request, env, storage, { now = Date.now, deadlineMs = 5000 } = {}) {
  const gate = requestGate(request, deadlineMs);
  try {
    await gate.wait(authenticateInventoryRoute(request, env)); const target = inventoryRoute(request); if (!target) fail(404, 'route_unavailable');
    const setting = env?.RESTORE_INVENTORY_PAGE_LIMIT ?? '1';
    if (typeof setting !== 'string' || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(setting)) fail(503, 'inventory_configuration_invalid');
    if(target.format===3&&Number(setting)>8)fail(503,'inventory_configuration_invalid');
    const options = { gate, now, pageLimit: Number(setting), format:target.format }; let result;
    if (target.kind === 'control') result = await readInventoryControl(storage, options);
    else if (target.kind === 'lookup') result = await lookupInventoryOperation(storage, target.operation_id, options);
    else if (target.kind === 'page') result = await readInventoryPage(storage, target.recovery_id, target.chain, target.page, options);
    else if (target.kind === 'progress') result = await readInventoryProgress(storage, target.recovery_id, target.chain, options);
    else {
      const value = await readCanonical(request, gate, target.kind === 'observe' ? LIMITS.observation : LIMITS.operation);
      if (target.kind === 'capability') result = await upgradeInventoryCapability(storage,value,options);
      else if(target.kind==='late') result=await observeHistoricalReply(storage,value,options);
      else if (target.kind === 'upgrade') result = await upgradeInventory(storage, value, options);
      else if (target.kind === 'admission') result = await admitInventory(storage, value, options);
      else if (target.kind === 'prepare') result = await prepareInventory(storage, value, options);
      else if (target.kind === 'acknowledge') result = await acknowledgeInventory(storage, target.operation_id, value, options);
      else if (target.kind === 'dispatch') result = await dispatchInventory(storage, value, options);
      else if (target.kind === 'observe') result = await observeInventory(storage, value, options);
      else if (target.kind === 'begin') result = await beginInventoryRecovery(storage, value, options);
      else if (target.kind === 'cut') result = await createInventoryCut(storage, target.recovery_id, value, options);
      else result = await acknowledgeInventoryPage(storage, target.recovery_id, value, options);
    }
    bounded(result, LIMITS.response, 'inventory_response_too_large', 503); gate.check(); return response(result);
  } catch (error) { return errorResponse(error); } finally { gate.close(); }
}
