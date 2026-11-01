# Privacy export recovery — current contract

The integrated implementation keeps the Complete package's chunked export **v3**
and its exact authority/acknowledgement boundaries. The independent V3 readiness
package's earlier export v2 modules are superseded; they must not replace
`privacy-export-delivery.ts`, `privacy-export-chunks.ts` or the current native
chunked export journals.

Create one original request identity. Authenticate every delivery attempt against
the current account, session and publication. Verify chunk order, length and
digest, then the complete result. Stage bytes durably in protected application
storage before acknowledging publication with its separate original operation
key. Ambiguous creation, chunk retrieval, durable staging and acknowledgement
remain distinct recoverable states. A session/account switch cannot release a
late private response or a file belonging to another account.

Save or Share remains a separate user action against its immutable selected
photo/export owner. A permission prompt, billing sheet, pager movement or relaunch
cannot substitute the current visible item for the originally requested item.
Document-provider cancellation is not a successful save. Platform-specific
backup exclusions and exact temporary-file cleanup preserve that ownership.

The database export catalog includes permitted managed Auth lifecycle metadata,
but excludes managed access/refresh tokens, encrypted credential bodies, IVs,
creation markers, service keys and journal authentication material. The managed
Auth cleanup guard and the independent push retirement proof must complete before
account erasure can report success.

Actual native document-provider writes, received byte/digest comparison, reboot,
storage failure and signed-device acceptance remain tasks D04/I03/Q02. A host
fixture or local filesystem test alone does not establish those results.
