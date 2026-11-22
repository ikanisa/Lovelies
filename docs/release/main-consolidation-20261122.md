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
steps and no assigned runner; a log request returned BlobNotFound. This does not
establish an application-test failure or a specific billing/configuration cause.
The old main checkpoint used `[skip ci]`; its commit is not a passing CI result.

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

## Remaining source-integration work

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
