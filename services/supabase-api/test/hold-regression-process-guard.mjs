// Selected test children have no reason to launch other processes. This is a
// JavaScript guard; OS sandbox/process postflight remains independently needed.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('hold_regression_child_process_forbidden'); };
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name] = denied;
syncBuiltinESMExports();
