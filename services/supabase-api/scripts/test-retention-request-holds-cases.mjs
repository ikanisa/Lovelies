/** Exact reviewed same-subject, PGlite-only hold cases. A pinned plan and
 * source hashes prevent silent scope changes. No configured database is allowed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.TEST_DATABASE_URL, undefined, 'remove TEST_DATABASE_URL before this runner');
const planPath = 'test/retention-request-hold-offline-cases.json';
const digest = value => createHash('sha256').update(value).digest('hex');
const planBytes = fs.readFileSync(planPath);
assert.equal(digest(planBytes), '7b6a2dd060d10d8d4d60cf0862c97625239d824350ecb3bca012db486d689a87', 'hold selection changed; review the fixed plan and its callers');
const plan = JSON.parse(planBytes);
const allowedFiles = ['test/retention-request-hold-candidate.test.mjs', 'test/retention-request-hold-fixture.mjs',
  'test/offline-regression-guard.mjs', 'test/restore-retention-network-guard.mjs', 'test/hold-regression-process-guard.mjs'];
assert.deepEqual(Object.keys(plan).sort(), ['cases','files','reviewed_result_sha256','source_plan_sha256','test_file','version']);
assert.equal(plan.version, 1);
assert.equal(plan.test_file, allowedFiles[0]);
assert.equal(plan.source_plan_sha256, '4b45d8a1a80141f3cc51ea85302a01e8a36c26e519be43dbff1f9eed96fe7128');
assert.equal(plan.reviewed_result_sha256, '0d0734710ac0febc3a8b1011b3b344f3b7e004181583b676673828c368bf70d7');
assert.deepEqual(Object.keys(plan.files), allowedFiles);
for (const file of allowedFiles) {
  assert.equal(digest(fs.readFileSync(file)), plan.files[file], 'hold test or guard changed: ' + file);
}
assert(fs.readFileSync(plan.test_file, 'utf8').includes('const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;'));
assert.equal(plan.cases.length, 24);
const seen = new Set();
for (const [index, item] of plan.cases.entries()) {
  assert.deepEqual(Object.keys(item).sort(), ['id','name']);
  assert.equal(item.id, 'candidate-request-holds-case-' + String(index + 1).padStart(3, '0'));
  assert.equal(typeof item.name, 'string');
  assert.match(item.name, /^[\x20-\x7e]+$/);
  assert(!seen.has(item.name), 'duplicate hold case');
  seen.add(item.name);
}

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



// No unrecognized stderr is accepted; optional Node type-transform warning is
// matched as one exact two-line pair. Hold cases expect no failure diagnostic.
function requireStderr(output) {
  assert(!/[\u0000\ufffd\r]/.test(output), 'invalid stderr characters');
  assert(output === '' || output.endsWith('\n'), 'unterminated stderr');
  const lines = output === '' ? [] : output.slice(0, -1).split('\n');
  const warning = /^\(node:[1-9][0-9]*\) ExperimentalWarning: Transform Types is an experimental feature and might change at any time$/;
  const hint = '(Use `node --trace-warnings ...` to show where the warning was created)';
  let warnings = 0;
  for (let i = 0; i < lines.length; i++) {
    assert(warning.test(lines[i]), 'unexpected diagnostic');
    assert.equal(lines[++i], hint, 'malformed warning pair');
    warnings++;
  }
  assert(warnings <= 1, 'duplicate runtime warning');
}

const baseArgs = ['--experimental-transform-types', '--import', './test/restore-retention-network-guard.mjs', '--import', './test/hold-regression-process-guard.mjs'];
const testArgs = ['--test', '--test-isolation=none', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000'];

// Save the exact captured bytes and status before accepting or rejecting a
// child. Encoded chunks are also written synchronously to the CI job log.
const evidenceParent = process.env.LOVELIES_HOLD_EVIDENCE_PARENT;
assert.equal(typeof evidenceParent, 'string', 'evidence parent is required');
assert(path.isAbsolute(evidenceParent), 'evidence parent must be absolute');
const evidenceDir = fs.mkdtempSync(path.join(evidenceParent, 'lovelies-hold-'));
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
  line('HOLD-EVIDENCE-BEGIN ' + JSON.stringify(record));
  for (const [stream, data] of [['stdout', stdout], ['stderr', stderr]]) {
    for (let offset = 0, index = 0; offset < data.length; offset += 12288, index++) {
      line('HOLD-EVIDENCE-CHUNK ' + record.id + ' ' + stream + ' ' + index + ' ' + data.subarray(offset, offset + 12288).toString('base64'));
    }
  }
  line('HOLD-EVIDENCE-END ' + record.id);
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
    try { writeAll(2, Buffer.from('HOLD-EVIDENCE-RETENTION-FAILED ' + JSON.stringify({record, stdout_base64: stdout.toString('base64'), stderr_base64: stderr.toString('base64')}) + '\n')); } catch {}
    throw Error('hold regression evidence could not be retained: ' + error.message, { cause: error });
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
    requireStderr(decoder.decode(stderr));
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
    throw Error('hold regression ' + id + ': ' + failure.message, { cause: failure });
  }
}
const names = plan.cases.map(item => item.name);
// The callbacks must be skipped whenever the database variable is defined;
// a non-URL and the import guard prevent accidentally reaching an external DB.
for (const [id, value] of [['database-skip-empty', ''], ['database-skip-nonempty', 'not-a-database-url']]) {
  execute([...baseArgs, ...testArgs, plan.test_file], { ...process.env, TEST_DATABASE_URL: value }, names, true, id);
}
const env = { ...process.env }; delete env.TEST_DATABASE_URL;
for (const item of plan.cases) {
  const selector = '^(?:' + item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')$';
  execute([...baseArgs, '--import', './test/offline-regression-guard.mjs', ...testArgs,
    '--test-name-pattern=' + selector, plan.test_file], env, [item.name], false, item.id);
  writeAll(1, Buffer.from('PASS ' + item.id + ': ' + item.name + '\n'));
}
writeAll(1, Buffer.from('Offline request holds: 24 passed; two defined-database skip controls passed.\n'));
