# Kinyarwanda resource draft

[rw-resource-draft.json](rw-resource-draft.json) is an **unapproved, unshipped language-review draft** for Q02. It contains all211 currently extracted Android resources (209 strings and two plural entries) and the seven iOS count dictionaries. English source text, resource IDs, source hashes, placeholders, plural structure and terminology uncertainties are retained.

This covers existing extracted resources. It does not establish whole-app localization: remaining hardcoded release-visible copy, dynamic status/error text and other iOS strings still need extraction. Native-language review must preserve the separate consent purposes, exactly three enrollment captures, registered-reference authentication, private uploads, exact approved recipient subsets and recipient acceptance. It must add no OTP, liveness or civil-identity claim.

After language review, integrate resources through the native localization systems and qualify actual English/Kinyarwanda journeys, zero/one/many counts, long names, large text/Dynamic Type, accessibility and fallback behavior. Other languages and bidirectional checks apply to the configured supported locale set. Store territory availability does not establish language support.

The packaged app still uses its existing English resources. The connected count-copy fix has separate compile/unit and actual packaged-resource proof; those checks do not approve this translation or complete Q02.
