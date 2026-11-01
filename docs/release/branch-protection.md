# Required release branch protection

The integration branch is a review candidate. A source commit, local test receipt or draft pull request is not permission to bypass the final release gates.

Readback on 1 November 2026 found `main` at `34b30678a64bf00933c8aeb979cccbcf622aa338`, with `protected:false`. The connected repository tools support source/PR writes and ruleset reads but expose no administration write capability. No separate GitHub administration credential was available. Actual enforcement therefore remains open under S06; this document does not claim that settings changed.

After the candidate's real checks run, configure an active branch ruleset for `refs/heads/main` with no routine bypass actor:

- Require a pull request, at least one independent approval, dismissal of stale reviews, approval of the last reviewable push by someone else, and resolution of review threads.
- Require current-branch status checks for `postgres-protocol`, `local-contracts (1)`, `local-contracts (2)`, `local-contracts (3)`, `android-debug`, and `ios-simulator-compile`. Verify the actual check names against the final commit before enforcement. Pin each required check to its observed GitHub Actions application identity.
- Block branch deletion and non-fast-forward updates. Keep the selected test, lockfile, workflow and model/image changes subject to the same review rules.
- Preserve the manual-only local-readiness workflow. Do not turn on additional billed workflows or alter account billing as a side effect of protection setup.

Retain the returned ruleset ID, exact configuration and an actual readback of active rules for `main`. Verify that a deliberately failing candidate cannot merge and that checks from another publisher cannot satisfy the rule. This is the acceptance evidence for enforcement, not a screenshot of a proposed form.

The release evidence gate requires source/configuration/artifact identities and domain-appropriate qualification receipts. Preserve the dependency inventory and artifact notices, and generate native/container SBOM and signing provenance from the exact release builds. JavaScript advisory results alone do not qualify Android, iOS, model binaries or operating-system packages.

Official API and behavior references, checked 1 November 2026:

- https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset — administration write permission, ruleset conditions and required-check publisher binding.
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets — required checks and strict up-to-date behavior.
