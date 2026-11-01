import { ApiError } from './types.ts';

export const AUDIENCE_POLICY = 'audience-2026-10-24-v1';
export const AUDIENCE_PROTOCOL = 'lovelies-audience-v2';
export const AUDIENCE_RULE = 'audience-13-plus-guardian-v1';
export const AUDIENCE_TERRITORY = 'global';
export const AUDIENCE_REVIEW_MS = 365 * 86400000;
export const AUDIENCE_RECOVERY_MS = 86400000;
export type DecisionSource = 'self_declaration' | 'independent_review' | 'legacy_declaration';
export type Decision = { at_least_13: boolean; guardian_required: boolean };
export type AudienceRow = {
 account_id: string; age_band: 'under13' | '13_17' | '18_plus' | null;
 status: string; version: number; declared_at: number; policy_version: string; next_review_at: number | null;
 decision_protocol: 'legacy-v1' | 'decision-v2'; at_least_13: number | null; guardian_required: number | null;
 decision_source: DecisionSource | null; rule_version: string | null; territory: string | null;
};
// age_band below is an in-memory compatibility discriminator, never a v2 write
// or wire field. The two decisions encode the same three outcomes; this does not
// claim that renaming them makes those outcomes less informative.
export type AudienceDecision = Omit<AudienceRow, 'age_band' | 'next_review_at' | 'decision_source' | 'rule_version' | 'territory'> & {
 age_band: 'under13' | '13_17' | '18_plus'; next_review_at: number;
 decision_source: DecisionSource; rule_version: string; territory: string;
};
export function decisionInput(value: Record<string, unknown>): Decision {
 if (typeof value.at_least_13 !== 'boolean' || typeof value.guardian_required !== 'boolean' ||
     !value.at_least_13 && value.guardian_required) throw new ApiError(400, 'audience_input_invalid');
 return { at_least_13: value.at_least_13, guardian_required: value.guardian_required };
}
export function decisionBand(value: Decision): AudienceDecision['age_band'] {
 return !value.at_least_13 ? 'under13' : value.guardian_required ? '13_17' : '18_plus';
}
export function normalizeAudience(row: AudienceRow | null): AudienceDecision | null {
 if (!row) return null;
 const legacy = row.decision_protocol === 'legacy-v1';
 if (!Number.isSafeInteger(row.declared_at) || row.declared_at < 0 ||
     row.declared_at > 8640000000000000 - AUDIENCE_REVIEW_MS ||
     !Number.isSafeInteger(row.version) || row.version < 1 ||
     !['blocked','guardian_pending','eligible','suspended'].includes(row.status))
  throw new ApiError(503, 'audience_decision_unavailable');
 let band: AudienceDecision['age_band'];
 if (legacy) {
  if (!['under13','13_17','18_plus'].includes(row.age_band ?? '') ||
      [row.at_least_13,row.guardian_required,row.decision_source,row.rule_version,row.territory].some(x => x !== null))
   throw new ApiError(503, 'audience_decision_unavailable');
  band = row.age_band!;
 } else {
  if (row.decision_protocol !== 'decision-v2' || row.age_band !== null ||
      ![0,1].includes(row.at_least_13!) || ![0,1].includes(row.guardian_required!) ||
      row.at_least_13 === 0 && row.guardian_required === 1 ||
      !['self_declaration','independent_review','legacy_declaration'].includes(row.decision_source ?? '') ||
      row.rule_version !== AUDIENCE_RULE || row.territory !== AUDIENCE_TERRITORY || row.next_review_at === null)
   throw new ApiError(503, 'audience_decision_unavailable');
  band = decisionBand({at_least_13: row.at_least_13 === 1, guardian_required: row.guardian_required === 1});
 }
 const deadline = Math.min(row.next_review_at ?? row.declared_at + AUDIENCE_REVIEW_MS, row.declared_at + AUDIENCE_REVIEW_MS);
 if (!Number.isSafeInteger(deadline) || deadline <= row.declared_at) throw new ApiError(503, 'audience_decision_unavailable');
 return {...row, age_band:band, next_review_at:deadline,
  decision_source:legacy?'legacy_declaration':row.decision_source!,
  rule_version:legacy?AUDIENCE_RULE:row.rule_version!, territory:legacy?AUDIENCE_TERRITORY:row.territory!};
}
export const audienceBandSQL = (alias: string): string => `(CASE WHEN ${alias}.decision_protocol='decision-v2' THEN
 CASE WHEN ${alias}.at_least_13=0 THEN 'under13' WHEN ${alias}.guardian_required=1 THEN '13_17' ELSE '18_plus' END ELSE ${alias}.age_band END)`;
export const audienceDeadlineSQL = (alias: string): string => `least(coalesce(${alias}.next_review_at,${alias}.declared_at+${AUDIENCE_REVIEW_MS}),${alias}.declared_at+${AUDIENCE_REVIEW_MS})`;
export function decisionProjection(row: AudienceDecision | null, now: number, minorActive = false): Record<string, unknown> {
 if (!row) return {at_least_13:null,guardian_required:null,status:'unknown',version:0,policy_version:null,
  source:null,rule_version:null,territory:null,declared_at:null,next_review_at:null,review_required:false};
 const expired = row.next_review_at <= now;
 return {at_least_13:row.age_band!=='under13',guardian_required:row.age_band==='13_17',
  status:row.age_band==='under13'?'blocked':row.age_band==='13_17'&&!minorActive?'guardian_pending':expired?'suspended':row.status,
  version:row.version,policy_version:row.policy_version,source:row.decision_source,rule_version:row.rule_version,
  territory:row.territory,declared_at:new Date(row.declared_at).toISOString(),next_review_at:new Date(row.next_review_at).toISOString(),review_required:expired};
}

export const audienceDecisionColumns = `decision_protocol TEXT NOT NULL DEFAULT 'legacy-v1' CHECK(decision_protocol IN('legacy-v1','decision-v2')),
 at_least_13 INTEGER,guardian_required INTEGER,decision_source TEXT,rule_version TEXT,territory TEXT,
 CHECK((decision_protocol='legacy-v1' AND age_band IS NOT NULL AND at_least_13 IS NULL AND guardian_required IS NULL AND decision_source IS NULL AND rule_version IS NULL AND territory IS NULL)
 OR(decision_protocol='decision-v2' AND age_band IS NULL AND at_least_13 IS NOT NULL AND guardian_required IS NOT NULL AND decision_source IS NOT NULL AND rule_version IS NOT NULL AND territory IS NOT NULL AND at_least_13 IN(0,1) AND guardian_required IN(0,1) AND (at_least_13=1 OR guardian_required=0)
 AND decision_source IN('self_declaration','independent_review','legacy_declaration') AND rule_version='${AUDIENCE_RULE}' AND territory='${AUDIENCE_TERRITORY}'
 AND next_review_at IS NOT NULL AND next_review_at>declared_at AND next_review_at<=declared_at+${AUDIENCE_REVIEW_MS}))`;

export const audienceReviewSchemaStatements: readonly string[] = [
 `CREATE TABLE IF NOT EXISTS audience_review_retirements(
  account_id TEXT NOT NULL REFERENCES accounts(id),audience_version INTEGER NOT NULL CHECK(audience_version>0),
  deadline INTEGER NOT NULL,retired_at INTEGER NOT NULL,recover_until INTEGER NOT NULL,
  profile_id TEXT,profile_revision TEXT,profile_epoch INTEGER,auth_consent_id TEXT,auth_policy TEXT,
  template_key TEXT,template_digest TEXT,cleanup_id TEXT,removal_verified_at INTEGER,
  enrollment_binding TEXT,enrollment_consent_id TEXT,enrollment_rebound_consent_id TEXT,enrollment_expires_at INTEGER,
  disposition TEXT NOT NULL CHECK(disposition IN('retained','renewed','removed')),
  PRIMARY KEY(account_id,audience_version),CHECK(retired_at>=deadline AND recover_until>=deadline AND recover_until<=deadline+${AUDIENCE_RECOVERY_MS}),
  CHECK((profile_id IS NULL AND profile_revision IS NULL AND profile_epoch IS NULL AND auth_consent_id IS NULL AND auth_policy IS NULL AND template_key IS NULL AND template_digest IS NULL AND cleanup_id IS NULL)
   OR(profile_id IS NOT NULL AND profile_revision IS NOT NULL AND profile_epoch IS NOT NULL AND template_key IS NOT NULL AND template_digest IS NOT NULL AND cleanup_id IS NOT NULL
    AND ((auth_consent_id IS NULL AND auth_policy IS NULL) OR (auth_consent_id IS NOT NULL AND auth_policy IS NOT NULL)))),
  CHECK((enrollment_binding IS NULL AND enrollment_consent_id IS NULL AND enrollment_rebound_consent_id IS NULL AND enrollment_expires_at IS NULL)
   OR(enrollment_binding IS NOT NULL AND length(enrollment_binding)=64 AND enrollment_consent_id IS NOT NULL AND enrollment_expires_at IS NOT NULL AND enrollment_expires_at>retired_at AND profile_id IS NULL)),
  CHECK(removal_verified_at IS NULL OR (removal_verified_at>=retired_at AND disposition='removed' AND profile_id IS NULL)),
  CHECK(disposition<>'retained' OR (profile_id IS NOT NULL AND auth_consent_id IS NOT NULL AND auth_policy IS NOT NULL AND recover_until>retired_at)))`,
 `CREATE INDEX IF NOT EXISTS audience_review_due ON account_audience(declared_at,account_id)`,
 `CREATE INDEX IF NOT EXISTS audience_review_reference_cleanup ON audience_review_retirements(cleanup_id) WHERE cleanup_id IS NOT NULL`,
];
