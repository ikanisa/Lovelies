#!/usr/bin/env node
/** Ordinary recovery cannot bypass a pending offline key rotation. */
import {readLifecycle} from './local-supabase-lifecycle.mjs';
import {keyFingerprint} from './local-supabase-managed-auth-rotation-core.mjs';
try{
 const gate=await readLifecycle('/run/lovelies');
 if(gate.state!=='open'||gate.key_sha256!==keyFingerprint(process.env.MANAGED_AUTH_ENCRYPTION_KEY))throw Error();
 process.argv=[process.argv[0],new URL('../services/supabase-api/scripts/restore-recovery.mjs',import.meta.url).pathname,...process.argv.slice(2)];
 await import('../services/supabase-api/scripts/restore-recovery.mjs');
}catch{console.error('Operator entry is blocked by deployment lifecycle or recovery configuration. No credential values were printed.');process.exitCode=1;}
