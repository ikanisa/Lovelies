/** Fixed same-subject, offline CI selection. Each callback gets a new process;
 * no configured database, native suite, or cross-account callback is admitted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.TEST_DATABASE_URL, undefined, 'remove TEST_DATABASE_URL before this runner');
const planPath = 'test/restore-retention-offline-cases.json';
const planBytes = fs.readFileSync(planPath);
const digest = value => createHash('sha256').update(value).digest('hex');
assert.equal(digest(planBytes), '1463a08a68c8a873a9b03a2371ed3ccd9172dfc433e4f6dc7fb68bee5eb297f7', 'offline selection changed; review the fixed plan and its callers');
const plan = JSON.parse(planBytes);
const counts = new Map([
  ['retention-saga-migration.test.mjs', 2],
  ['restore-retention-raw.test.mjs', 17],
  ['restore-retention-conflicts.test.mjs', 37],
  ['restore-retention-operator-saga.test.mjs', 33],
]);
assert.deepEqual(Object.keys(plan).sort(), ['cases','files','source_plan_sha256','version']);
assert.equal(plan.version, 1);
assert.equal(plan.source_plan_sha256, '65432148f95a5294be1886692d3f7439440b44213a85e3dcbe2f4df5d0f42317');
assert.deepEqual(Object.keys(plan.files), [...counts.keys()]);
assert.equal(plan.cases.length, 89);
const seen = new Set();
for (const [file, count] of counts) {
  assert.match(file, /^[a-z0-9-]+\.test\.mjs$/);
  const source = fs.readFileSync('test/' + file);
  assert.equal(digest(source), plan.files[file], 'offline test source changed: ' + file);
  assert(source.includes('const test = process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;'));
  assert.equal(plan.cases.filter(item => item.file === file).length, count);
}
for (const item of plan.cases) {
  assert.deepEqual(Object.keys(item).sort(), ['file', 'name']);
  assert(counts.has(item.file));
  assert.equal(typeof item.name, 'string');
  assert.match(item.name, /^[\x20-\x7e]+$/);
  const key = item.file + '\0' + item.name;
  assert(!seen.has(key), 'duplicate offline case');
  seen.add(key);
}

// Pin the exact safety guards independently of the unchanged 89-case plan.
const guardHashes = {"test/restore-retention-network-guard.mjs": "72f2880b2290dc3564222b8cfe3f1d27c076c844100c6ac0cb1a91a9c3dcc6cf", "test/offline-regression-guard.mjs": "e93a3f9eb0062bd8f9df8d420a6e599e7c4ba72c99fada0c564a8d67f2451988", "test/hold-regression-process-guard.mjs": "14df64a8857e5fc4bae3898938268dd436aa739bb276e53e515fcf33a8c4b1f1"};
for (const [file, expected] of Object.entries(guardHashes)) assert.equal(digest(fs.readFileSync(file)), expected, "guard changed: " + file);

// Accept only a complete, unambiguous passing TAP report for the selected
// case(s). Diagnostics are bounded to one indented TAP YAML block per result.
function requireTap(output, names, skipped) {
  assert(!/[\u0000\ufffd\r]/.test(output), 'invalid TAP characters');
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.shift(), 'TAP version 13');
  let yaml = false, planLine = false, yamlCount = 0, durationCount = 0;
  const subtests = [], results = [], totals = new Map();
  const expectedNames = new Set(names), seenNames = new Set();
  assert.equal(expectedNames.size, names.length, 'duplicate expected name');
  for (const line of lines) {
    assert(!/^\s*(?:#\s*)?bail\s+out\b/i.test(line), 'TAP bailout');
    if (yaml) {
      if (yaml === 1) {
        assert(/^  duration_ms: (?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(line), 'unexpected or duplicate TAP duration field');
        yaml = 2; continue;
      }
      if (yaml === 2) { assert.equal(line, "  type: 'test'", 'unexpected or duplicate TAP type field'); yaml = 3; continue; }
      assert.equal(line, '  ...', 'unexpected TAP diagnostic field or malformed terminator');
      yaml = false; continue;
    }
    if (line === '') continue;
    if (line === '  ---') {
      assert(!planLine && results.length === yamlCount + 1, 'misplaced TAP diagnostics');
      yamlCount++; yaml = 1; continue;
    }
    if (line.startsWith('# Subtest: ')) {
      assert(!planLine && subtests.length === results.length, 'misplaced subtest');
      subtests.push(line.slice('# Subtest: '.length)); continue;
    }
    const result = /^(ok|not ok) ([0-9]+) - (.*)$/.exec(line);
    if (result) {
      assert(!planLine && result[1] === 'ok' && subtests.length === results.length + 1, 'failed or misplaced test');
      assert.equal(Number(result[2]), results.length + 1);
      const suffix = skipped ? ' # SKIP' : '';
      if (skipped) assert(result[3].endsWith(suffix), 'selected test was not skipped');
      const name = skipped ? result[3].slice(0, -suffix.length) : result[3];
      assert(expectedNames.has(name), 'unexpected test name');
      assert(!seenNames.has(name), 'duplicate test result');
      assert.equal(name, subtests.at(-1), 'result does not match its subtest');
      seenNames.add(name); results.push(name); continue;
    }
    if (/^[0-9]+\s*\.\./.test(line)) {
      assert(!planLine && line === '1..' + names.length && results.length === names.length, 'unexpected TAP plan');
      planLine = true; continue;
    }
    const counter = /^# (tests|suites|pass|fail|cancelled|skipped|todo) ([0-9]+)$/.exec(line);
    if (counter) {
      assert(planLine && !totals.has(counter[1]), 'duplicate or misplaced TAP counter');
      totals.set(counter[1], Number(counter[2])); continue;
    }
    if (/^# duration_ms (?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(line)) {
      assert(planLine && ++durationCount === 1, 'duplicate or misplaced TAP duration'); continue;
    }
    throw Error('unexpected TAP record: ' + line.slice(0, 120));
  }
  assert(!yaml && planLine && durationCount === 1);
  assert.equal(subtests.length, names.length);
  assert.equal(results.length, names.length);
  assert.equal(yamlCount, names.length, 'missing or extra TAP diagnostics');
  assert.deepEqual([...seenNames].sort(), [...expectedNames].sort());
  const expectedTotals = { tests: names.length, suites: 0, pass: skipped ? 0 : names.length,
    fail: 0, cancelled: 0, skipped: skipped ? names.length : 0, todo: 0 };
  assert.deepEqual(Object.fromEntries(totals), expectedTotals);
}



function requireStderr(output, names, skipped) {
  assert(!/[\u0000\ufffd\r]/.test(output), 'invalid stderr characters');
  assert(output === '' || output.endsWith('\n'), 'unterminated stderr');
  const lines = output === '' ? [] : output.slice(0, -1).split('\n');
  const warning = /^\(node:[1-9][0-9]*\) ExperimentalWarning: Transform Types is an experimental feature and might change at any time$/;
  const hint = '(Use `node --trace-warnings ...` to show where the warning was created)';
  let warnings = 0; const diagnostics = [];
  for (let i = 0; i < lines.length; i++) {
    if (warning.test(lines[i])) { assert.equal(lines[++i], hint, 'malformed warning pair'); warnings++; continue; }
    diagnostics.push(lines[i]);
  }
  assert(warnings <= 1, 'duplicate runtime warning');
  const expectedNames = new Set(["a lost committed asset reply resumes the same plan with the same allocations", "old successful receipt replays and same-key pending reservations conflict with a retention update", "a completed preview accepts a later same-version raw retirement only with exact independent evidence", "a locally fabricated raw retirement cannot justify completing a prior preview item"]);
  const clockName = "the deferred DB-clock guard aborts if fresh authority expires after validation but before COMMIT";
  const expected = !skipped && names.length === 1 && names[0] === clockName
    ? ['lovelies_api_failure error'] : !skipped && names.length === 1 && expectedNames.has(names[0])
    ? ['lovelies_api_failure Error'] : [];
  assert.deepEqual(diagnostics, expected, 'unexpected or missing diagnostic');
}

const baseArgs = ['--experimental-transform-types', '--import', './test/restore-retention-network-guard.mjs', '--import', './test/hold-regression-process-guard.mjs'];
const testArgs = ['--test', '--test-isolation=none', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000'];

// Save the exact captured bytes and status before accepting or rejecting a
// child. Encoded chunks are also written synchronously to the CI job log.
const evidenceParent = process.env.LOVELIES_RETENTION89_EVIDENCE_PARENT;
assert.equal(typeof evidenceParent, 'string', 'evidence parent is required');
assert(path.isAbsolute(evidenceParent), 'evidence parent must be absolute');
const evidenceDir = fs.mkdtempSync(path.join(evidenceParent, 'lovelies-retention89-'));
const MAX_BUFFER = 4 * 1024 * 1024;
function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const count = fs.writeSync(fd, data, offset, data.length - offset);
    assert(Number.isInteger(count) && count > 0, 'short or failed evidence write');
    offset += count;
  }
}
function saveFile(name, data) {
  const fd = fs.openSync(path.join(evidenceDir, name), 'wx', 0o600);
  try { writeAll(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function emitRecord(record, stdout, stderr) {
  const line = value => writeAll(1, Buffer.from(value + '\n'));
  line('RETENTION89-EVIDENCE-BEGIN ' + JSON.stringify(record));
  for (const [stream, data] of [['stdout', stdout], ['stderr', stderr]]) {
    for (let offset = 0, index = 0; offset < data.length; offset += 12288, index++) {
      line('RETENTION89-EVIDENCE-CHUNK ' + record.id + ' ' + stream + ' ' + index + ' ' + data.subarray(offset, offset + 12288).toString('base64'));
    }
  }
  line('RETENTION89-EVIDENCE-END ' + record.id);
}
function retain(record, stdout, stderr) {
  try {
    saveFile(record.id + '.stdout.bin', stdout);
    saveFile(record.id + '.stderr.bin', stderr);
    saveFile(record.id + '.status.json', Buffer.from(JSON.stringify(record) + '\n'));
    emitRecord(record, stdout, stderr);
  } catch (error) {
    // Even when the evidence directory fails, attempt to expose captured bytes
    // and status through the failing job log; never count this child as passed.
    try { writeAll(2, Buffer.from('RETENTION89-EVIDENCE-RETENTION-FAILED ' + JSON.stringify({record, stdout_base64: stdout.toString('base64'), stderr_base64: stderr.toString('base64')}) + '\n')); } catch {}
    throw Error('retention regression evidence could not be retained: ' + error.message, { cause: error });
  }
}
function execute(args, env, names, skipped, id) {
  const result = spawnSync(process.execPath, args, { env, timeout: 40000, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER });
  const haveStdout = Buffer.isBuffer(result.stdout), haveStderr = Buffer.isBuffer(result.stderr);
  const stdout = haveStdout ? result.stdout : Buffer.alloc(0), stderr = haveStderr ? result.stderr : Buffer.alloc(0);
  const code = result.error?.code ?? null;
  const timedOut = code === 'ETIMEDOUT', truncated = code === 'ENOBUFS' || stdout.length >= MAX_BUFFER || stderr.length >= MAX_BUFFER;
  let failure = null;
  try {
    if (result.error || result.status !== 0 || result.signal !== null || !haveStdout || !haveStderr || timedOut || truncated)
      throw Error('child failed, timed out, or output is incomplete: ' + (result.error?.message ?? result.status));
    const decoder = new TextDecoder('utf-8', {fatal:true});
    requireTap(decoder.decode(stdout), names, skipped);
    requireStderr(decoder.decode(stderr), names, skipped);
  } catch (error) { failure = error; }
  const record = {version:1, id, selected:names, skipped, exit:result.status ?? null, signal:result.signal ?? null,
    error_code:code, error_message:result.error?.message ?? null, timed_out:timedOut, truncated,
    stdout_present:haveStdout, stderr_present:haveStderr,
    stdout_bytes:stdout.length, stderr_bytes:stderr.length, stdout_sha256:digest(stdout), stderr_sha256:digest(stderr),
    validation:failure ? 'failed' : 'passed', validation_error:failure?.message ?? null};
  retain(record, stdout, stderr);
  if (failure) {
    if (stdout.length) writeAll(2, stdout);
    if (stderr.length) writeAll(2, stderr);
    throw Error('retention regression ' + id + ': ' + failure.message, { cause: failure });
  }
}
const names = plan.cases.map(item => item.name);
const paths = [...counts.keys()].map(file => 'test/' + file);
// Defined values must skip all 89 callbacks. The network/process imports guard
// module loading as well, and the non-URL cannot identify a database target.
for (const [id, value] of [['database-skip-empty', ''], ['database-skip-nonempty', 'not-a-database-url']]) {
  execute([...baseArgs, ...testArgs, ...paths], { ...process.env, TEST_DATABASE_URL: value }, names, true, id);
}
const env = { ...process.env }; delete env.TEST_DATABASE_URL;
for (const [index, item] of plan.cases.entries()) {
  const selector = '^(?:' + item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')$';
  const id = 'restore-retention-case-' + String(index + 1).padStart(3, '0');
  execute([...baseArgs, '--import', './test/offline-regression-guard.mjs', ...testArgs,
    '--test-name-pattern=' + selector, 'test/' + item.file], env, [item.name], false, id);
  writeAll(1, Buffer.from('PASS ' + id + ': ' + item.file + ': ' + item.name + '\n'));
}
writeAll(1, Buffer.from('Offline restore and retention cases: 89 passed; two defined-database skip controls passed.\n'));
