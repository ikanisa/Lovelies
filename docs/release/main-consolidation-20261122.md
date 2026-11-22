# Main-branch consolidation checkpoint — 22 November 2026

## Scope and disposition

The owner requested that completed project work be committed and pushed to
`main`. This additive checkpoint supplies source-preservation and reconciliation
tooling. It does not claim that the earlier implementation candidate has been
merged or that all historical chat deliverables have been recovered.

The existing application source is retained unchanged. No force-push, branch
deletion, deployment, database migration or store submission is part of this
checkpoint. Locally hosted Supabase remains the selected architecture.

## Pinned source histories observed before this checkpoint

| Source | Commit | Observed role |
| --- | --- | --- |
| Common baseline | `34b30678a64bf00933c8aeb979cccbcf622aa338` | Parent of both application workstreams |
| Main | `07a72466f88e703533e8177828bab9d1a4438687` | 22 November download recovery, retention and backup checkpoint |
| Implementation candidate | `385de8659b737cbb383f184ce014d7dc165a2a1c` | Draft PR #1, local-Supabase/backend/mobile/admin implementation |
| Source-export tooling | `f5363103083f060653e23099977cdc1953e5d829` | Earlier isolated Drive-export workstream |

Main advanced after the original repository inspection. Replacing it with the
older candidate would discard newer work. PR #1 was observed open, draft and
not mergeable, with 531 changed files relative to its recorded baseline. Its
implementation record is historical source evidence, not evidence that those
changes are active on the current main branch.

The earlier candidate CI runs were marked failed. Inspected service jobs had no
steps and no assigned runner; a log request returned BlobNotFound. Those original
observations alone did not establish an application-test failure or a specific
billing/configuration cause. A later, separately scoped diagnosis of the new
main-branch audit job is recorded below. The old main checkpoint used `[skip ci]`;
its commit is not a passing CI result.

## New read-only audit

`project-consolidation-audit.py` accepts only full pinned commit SHAs and requires
an explicit verified merge base. It reads the source Git objects through a
disposable bare repository, preserving all selected histories in a self-contained
Git bundle. It produces a per-source Git object manifest, a textual merge-conflict
report and SHA-256 checksums. It refuses to overwrite evidence or write outputs
inside the source checkout. It does not change the source refs, index or files.

The workflow uses read-only repository permissions and pinned action revisions.
It performs synthetic audit-tool tests before collecting repository evidence.
A successful audit means that a report and bundle were generated, not that the
application merge is safe or any release gate is satisfied. LFS object bytes and
external submodule repositories are not fetched by this audit.

Local validation of the new audit tooling: six synthetic Git tests passed,
including a clean divergent merge, conflicting changes, preservation of source
refs/worktree, independent bundle restoration, included ancestry, invalid-input
rejection and refusal to overwrite evidence. These are not Lovelies application
tests. A hosted workflow result must be inspected separately.

## Verified push and hosted CI blocker

The audit tooling was committed and published on `main` as
`78a4d98d0a9d02b6cfce86bed3325fc02c77cc9b`. GitHub ref and file readbacks confirmed
the publication. This commit adds the audit script, its tests, the read-only
workflow and this checkpoint; it does not merge the application candidate.

GitHub started recording audit run `45047652914` for that exact commit. The
`preserve-and-compare` job, `137285654655`, was marked failed before execution.
Read-only browser inspection of the GitHub job page and its public annotations
endpoint reported the same exact failure annotation:

> The job was not started because your account is locked due to a billing issue.

Sources:

- Job: https://github.com/ikanisa/Lovelies/actions/runs/45047652914/job/137285654655
- Annotation: https://api.github.com/repos/ikanisa/Lovelies/check-runs/137285654655/annotations

This job did not execute the audit or application tests. No repository-history
bundle or actual-repository conflict report is claimed from this failed run.
The backend readiness run `45047652935` was also returned as failed, but its own
annotation was not separately inspected; the audit-job diagnosis is not a
substitute for reading other jobs' evidence. The earlier November 1 failures
remain historical failures rather than retroactively diagnosed results.

The GitHub account billing lock needs to be resolved before this hosted audit
can run, followed by a real rerun and inspection of its outputs. No billing
settings, payment information, spending limits or branch protection were changed.
A billing-unblocked runner would not itself establish application correctness.

## Remaining source-integration work

The exact schema sources were inspected on both application workstreams:

- At `78a4d98d0a9d02b6cfce86bed3325fc02c77cc9b`,
  `services/supabase-api/src/schema.ts` declares `currentSchemaVersion = 15`
  and includes the download-v2 schema extension.
- At `385de8659b737cbb383f184ce014d7dc165a2a1c`, the same path declares
  `currentSchemaVersion = 19` and includes managed Auth, processing-match,
  push-roster, restore-recovery, chunked-export and operator-capability extensions.

These observations show distinct schema implementations; choosing the higher
version number alone does not reconcile their migration histories or preserve
both sets of behavior.

Resolve the actual current-main/candidate conflicts without dropping either
workstream. Reconcile schema versions and migration checksums before combining
backend behavior; then validate backend contracts, both native clients, admin
flows and deployment tooling against the resulting exact commit. Do not choose
an entire branch as the conflict resolution merely to obtain a merge commit.

Historical Drive recovery records explicitly distinguish preserved snapshots
from a complete current-source export. Do not overlay older snapshots onto active
application code, publish private runtime/signing material, or mark every project
chat artifact recovered without an inspectable inventory. Missing source and
remaining host/device/provider acceptance stay open.
