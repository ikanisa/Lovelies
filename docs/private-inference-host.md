# Lovelies private inference host

26 October 2026. Use one private inference service behind the existing Supabase
API. The native apps, custom accounts/sessions, consents, private Storage,
review, recipient acceptance and grants remain owned by Lovelies/Supabase.
The inference service receives only admitted still images and candidate references.

## Selected service

- Host: Cloudflare Containers, account `2209b915a85b1c11cee79b7806c6e73b`.
- Placement: EU jurisdiction, WEUR, Linux AMD64. WEUR does not promise a specific city.
- Gateway: `https://lovelies-supabase-inference.ikanisa.workers.dev`.
- Configuration: [`wrangler.supabase.jsonc`](../services/ml-container-worker/wrangler.supabase.jsonc).
- Runtime: one container, 1 vCPU, 3 GiB, 8 GB disk; no Internet egress or SSH.
- Secret: server-only `ML_INFERENCE_SECRET`; never put it in clients or source.
- Routes: authenticated `GET /ready`, `POST /internal/face`, `POST /internal/photo`.

The configuration selects the existing immutable platform manifest directly:

```text
registry.cloudflare.com/2209b915a85b1c11cee79b7806c6e73b/lovelies-inference-native@sha256:982e2ed7bb66b17db17979495495892579f1b734c55d93516a2aeedbf70e1c6c
```

The retained native tests and connected journeys bind that artifact to package
`173b43d8f5d259f022f4fd83b7c658fc7ade3070e36321965436cd59f2da909f`, engine space
`lovelies-sface-openface-still-v1` and processing fingerprint
`e5366532fe94660257f2228e59e5d6032fd35d45ee41733d82c84aee440a26fa`.
Supabase checks the actually loaded identities and each bound inference reply.
A configuration string alone does not prove the loaded engine identity.

## Security correction

The retained raw scan reported 60 High rows across 15 advisories. The existing
exact-image review accounts for every High row: 40 affected implementation
payloads were omitted, four UUID rows are unaffected by the flagged tool
mechanisms, and 16 rows have specific patch or component-applicability evidence.
The raw report remains unchanged; its version-based exit code is not a count of
unfixed applicable High vulnerabilities. Lower-severity findings remain recorded
and must not be described as universally fixed.

The previous gateway required three extra fields: a serving flag, a mirrored
image URI and a receipt-shaped hash. It never verified the receipt. Those
fields and the misleading receipt-acceptance error were removed. The immutable
image is selected once in the actual container configuration; service
authentication, bounded transport and loaded-engine verification do the work.
There is no additional manual security-approval switch.

See the [26 October exact-image assessment](../verification/openface-integration-20261024/continuation/native-security-disposition-20261025/root-verification-20261026/assessment.json)
and [dated implementation/evidence](openface-integration-continuation.md).
The old `final_image_accepted=false` fields remain historical records; they are
not live configuration or instructions to rebuild an unchanged image.

## Build and operation

```sh
pnpm backend:ml:typecheck
pnpm --filter @lovelies/ml-container-worker test
pnpm backend:ml:build
```

The last command is a dry run of the selected Supabase gateway. It does not
build a native image, start a container, deploy, write secrets or change Supabase.
The old Cloudflare gateway is available only through explicit `dev:legacy` and
`build:legacy` commands with `wrangler.legacy.jsonc`; it is not the default.
The disabled-host generator and obsolete supplemental overlay producer have
been removed. Their source and failed evidence remain in Git/history.
The expired temporary native-build application and Worker were also deleted;
their build-input/evidence buckets and immutable registry artifacts remain.

When an authorized hosted deployment is performed, use this configuration and
its independent server-only secret. Check authenticated loaded `/ready` and
face/photo calls through the deployed HTTPS boundary before selecting its URL
in Supabase. No application or database credential belongs in this service.
A changed native runtime needs a new immutable image and explicit reference-space
compatibility; a gateway-only change does not change embeddings.

No production deployment was performed by this correction. Earlier disabled
Worker observations and isolated test execution are recorded separately in the
continuation evidence. Production configuration, representative recognition
acceptance and store distribution retain their actual outstanding status.

For rollback, select a preserved engine compatible with the profile space.
Never restore a database snapshot merely to undo an inference release: that can
revive revoked consent, grants or deleted references. Preserve unknown/test data
and failed evidence; stop only resources belonging to the completed test run.
