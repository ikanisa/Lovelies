/** Explicit, bounded-memory export inventory. Every SQL projection omits raw
 * credentials, device keys, storage paths, vectors and counterpart identities.
 * The private _export_index is removed before materialization. Queries execute
 * in one database snapshot; continuations only read the materialized snapshot. */
export type ExportDataset = Readonly<{ name:string; sql:string; copies?:number }>;
export const privacyExportDatasets:readonly ExportDataset[]=[
 {name:'managed_auth_history',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,local_session_id,operation,state,created_at,logout_verified_at,user_deleted_at FROM managed_auth_bindings WHERE account_id=?'},
 {name:'account',sql:'SELECT row_number() OVER(ORDER BY id) _export_index,id,name,identity_state,created_at,disabled_at FROM accounts WHERE id=?'},
 {name:'consents',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,purpose,policy_version,status,created_at,expires_at,revoked_at FROM consents WHERE account_id=?'},
 {name:'preferences',sql:'SELECT 1 _export_index,receive_matches,download_photos,updated_at FROM account_preferences WHERE account_id=?'},
 {name:'face_profile',sql:'SELECT 1 _export_index,id,revision,model_id,status,auth_enabled FROM face_profiles WHERE account_id=?'},
 {name:'owned_assets',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,source,batch_id,status,version,width,height,title,captured_at,created_at,deleted_at FROM assets WHERE owner_id=?'},
 {name:'photo_transfers',sql:'SELECT row_number() OVER(ORDER BY t.created_at,t.asset_id) _export_index,t.asset_id,t.bytes_received,t.state,t.created_at,t.expires_at,t.error_code FROM upload_transfers t JOIN assets a ON a.id=t.asset_id WHERE a.owner_id=?'},
 {name:'owned_snapshots',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,source,created_at,expires_at,privacy_redacted_at FROM sharing_snapshots WHERE owner_id=?'},
 {name:'owned_previews',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,source,draft_version,created_at,expires_at,committed_at,privacy_redacted_at FROM sharing_previews WHERE owner_id=?'},
 {name:'requests',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,source,status,created_at,expires_at,updated_at FROM sharing_requests WHERE sender_id=? OR recipient_id=?',copies:2},
 {name:'grants',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,asset_id,active,created_at,revoked_at FROM media_grants WHERE recipient_id=?'},
 {name:'privacy_requests',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,request_type,status,reason,created_at,reviewed_at,completed_at FROM privacy_requests WHERE subject_id=?'},
 {name:'export_deliveries',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,request_id,created_at,expires_at,acknowledged_at FROM privacy_export_deliveries WHERE subject_id=?'},
 {name:'export_publications',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,request_id,bytes,expires_at,status,created_at,content_format,chunk_count FROM privacy_exports WHERE subject_id=?'},
 {name:'export_snapshot_history',sql:"SELECT row_number() OVER(ORDER BY generated_at,id) _export_index,id,request_id,generated_at,status,row_count,total_bytes,chunk_count,expires_at FROM privacy_export_snapshots WHERE subject_id=? AND status<>'capturing'"},
 {name:'financial_records',sql:`SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,record_type,created_at,
   jsonb_strip_nulls(jsonb_build_object(
    'amount',CASE WHEN jsonb_typeof(data_json::jsonb->'amount')='number' THEN data_json::jsonb->'amount' END,
    'tax',CASE WHEN jsonb_typeof(data_json::jsonb->'tax')='number' THEN data_json::jsonb->'tax' END,
    'total',CASE WHEN jsonb_typeof(data_json::jsonb->'total')='number' THEN data_json::jsonb->'total' END,
    'currency',CASE WHEN jsonb_typeof(data_json::jsonb->'currency')='string' AND data_json::jsonb->>'currency'~'^[A-Z]{3}$' THEN data_json::jsonb->'currency' END,
    'status',CASE WHEN data_json::jsonb->>'status' IN('paid','pending','settled','refunded','cancelled','failed') THEN data_json::jsonb->'status' END)) data
   FROM financial_records WHERE account_id=?`},
 {name:'subscriptions',sql:'SELECT row_number() OVER(ORDER BY starts_at,id) _export_index,provider,product_id,billing_environment,active,starts_at,expires_at,observed_at FROM store_subscriptions WHERE account_id=?'},
 {name:'store_transactions',sql:'SELECT row_number() OVER(ORDER BY starts_at,id) _export_index,provider,transaction_id,billing_environment,product_id,starts_at,expires_at,active,financial_eligible FROM store_transactions WHERE account_id=?'},
 {name:'downloads',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,asset_id,created_at,financial_eligible FROM download_records WHERE account_id=?'},
 {name:'support_requests',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,subject,details,status,created_at,updated_at,review_outcome,review_notes FROM support_requests WHERE account_id=?'},
 {name:'own_reports',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,reason,status,outcome,created_at,reviewed_at FROM safety_reports WHERE reporter_id=?'},
 {name:'notification_settings',sql:`SELECT 1 _export_index,a.id user_id,coalesce(n.match_alerts,1)=1 match_alerts,coalesce(n.payment_alerts,1)=1 payment_alerts,coalesce(n.support_alerts,1)=1 support_alerts FROM accounts a LEFT JOIN notification_settings n ON n.account_id=a.id WHERE a.id=?`},
 {name:'notifications',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,kind,title,created_at,read_at FROM notifications WHERE account_id=?'},
 {name:'push_devices',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,platform,active,created_at,updated_at FROM push_devices WHERE account_id=?'},
 {name:'asset_retention',sql:'SELECT row_number() OVER(ORDER BY r.asset_id) _export_index,r.asset_id,r.raw_expires_at,r.preview_expires_at,r.legal_hold FROM asset_retention r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=?'},
 {name:'retention_jobs',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,asset_id,kind,status,created_at,verified_at,error_code FROM retention_jobs WHERE subject_id=?'},
 {name:'audience_declaration',sql:'SELECT 1 _export_index,decision_protocol,age_band,at_least_13,guardian_required,decision_source,rule_version,territory,status,version,declared_at,policy_version,next_review_at FROM account_audience WHERE account_id=?'},
 {name:'guardian_child_requests',sql:'SELECT row_number() OVER(ORDER BY id) _export_index,id,state,revision,policy_version,created_at,expires_at,reviewed_at,terminated_at FROM guardian_requests WHERE child_account_id=?'},
 {name:'guardian_given_approvals',sql:'SELECT row_number() OVER(ORDER BY id) _export_index,id,purpose,policy_version,status,created_at,expires_at,revoked_at FROM guardian_purpose_approvals WHERE guardian_account_id=?'},
 {name:'operator_access_version',sql:'SELECT 1 _export_index,version FROM operator_access_versions WHERE account_id=?'},
 {name:'operator_capability_grants',sql:'SELECT row_number() OVER(ORDER BY created_at,id) _export_index,id,capability,created_at,expires_at,revoked_at FROM operator_capability_grants WHERE account_id=?'},
];
