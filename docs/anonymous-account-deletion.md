# Deleting an anonymous Lovelies account

An anonymous account can request its own deletion before enrolling a face. This
uses current enrollment credentials and a dedicated deletion boundary. Export,
gallery, uploads, sharing, private media and administrative review retain their
registered-account guards. No OTP or face enrollment is needed for deletion.

`POST /privacy/account-deletion` accepts the original `operation_key`,
`status_token` and optional `reason`. The native apps generate 32 secure random
bytes as `lvd_` followed by 64 lowercase hexadecimal digits. Before dispatch,
they save the exact request, account and API origin in encrypted private storage.
An uncertain write is reconciled using that same token and key. A different
body under the original key conflicts. The server stores only the token hash,
including in operation intent; a reused token cannot rebind an existing receipt.
Keys and reasons containing the supplied token are rejected before any write,
so other accepted metadata cannot carry its plaintext into durable records.

`POST /privacy/account-deletion/status` accepts only `{status_token}`, without
bearer credentials or URL parameters. It returns the original operation key,
request ID, deletion lifecycle, dates, failure code, request expiry and receipt
expiry. It exposes no account or reviewer identities, reasons, media keys or
credentials. The response is private and must not be cached. The receipt grants
only status access; it cannot approve deletion, process cleanup, restore an
account, download media or export data.

The receipt expires 30 days after creation and survives erasure of the account's
sessions and operations. The request has the existing seven-day review window;
`request_expired` distinguishes that expiry from a pending decision. Already
erased metadata with outstanding file cleanup continues its existing retry
obligation. Unknown, expired or revoked receipts return the same unavailable
result. None of these outcomes means that deletion completed.

The native apps restore a saved deletion record before automatic anonymous
bootstrap. Once the server acknowledges the request, the apps freeze guest
presentation, captures and private actions while retaining that same account's
encrypted credentials for recovery. A rejected, cancelled or expired request
offers an explicit **Resume setup** action: it revalidates or refreshes the
original anonymous account before releasing the hold. A failed recovery keeps
the receipt visible. A confirmed completed deletion retires the original guest
credentials; **Start again** is a separate explicit action.

Deletion still requires an independent current privileged review. The existing
legal holds, leases, writer fences, database erasure and verified R2 DELETE plus
absent-HEAD checks apply. A request acknowledgement, account disablement or
credential rejection is not proof of completed file deletion. The server reports
`deletion_completed:true` only for a stored completed request after cleanup.

This is the implemented protocol. Source-bound verification and remaining
platform/provider limits are recorded in
[the anonymous deletion evidence](/Users/jeanbosco/Documents/Lovelies/verification/anonymous-deletion-20261014/README.md).
