# Actual Lovelies implementation

The current backend is `services/cloudflare-api`: Cloudflare Worker, SQLite
Durable Object authority, private R2 and Queues. Default anonymous sessions
upgrade automatically after trusted selfie enrollment verification; no OTP
is used. `backend/local-entry.ts` and the default backend commands use this
service. [Current results and remaining gates](docs/cloudflare-transition.md).
The imported PostgreSQL backend and earlier verification below are preserved
as historical source, separately from the current Cloudflare port.

The earlier specification phase was implemented in the Flutter/Worker/Supabase
checkout at `/Volumes/T7/Recovered-G-PRO/MEMORIES`. This folder also preserves
the earlier screenshot-based native Android, SwiftUI and browser prototypes.

The subsequent backend reuse task copies the actual server source into this
workspace at `services/api-worker`, `shared/*.ts` and `supabase`, with a local
adapter at `backend/local-entry.ts` and a Fetch client at `clients/backend`.
[Backend reuse and fresh target results](docs/backend-reuse.md) records that
self-contained source separately from the earlier Flutter implementation.

- [Implementation, test results and remaining gates](/Volumes/T7/Recovered-G-PRO/MEMORIES/docs/lovelies/implementation-status.md)
- [Actual Flutter Android QA APK](/Users/jeanbosco/Documents/Lovelies/deliverables/Lovelies-Flutter-QA.apk)
- [Current exact-recipient review](/Users/jeanbosco/Documents/Lovelies/verification/flutter-core-journey-captures/02-final-recipient-review.png)
- [Final source and evidence binding](/Users/jeanbosco/Documents/Lovelies/verification/implementation-evidence-final.json)

The QA APK targets the actual `lib/main.dart` application. Hosted services and
migrations were not deployed. iOS SDK/device, Android 16KB, full provider-schema
and physical performance qualification remain open as recorded in the report.
