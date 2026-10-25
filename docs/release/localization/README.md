# English and Kinyarwanda localization

Current 25 October source inventory is Android 950 strings/17 plurals and
iOS 980 string keys, 13 plural-format entries containing 14 plural variables, and
three permission descriptions per language (EN/RW). Round8 bundle readback matches round7 and
confirms both stable-action translations and the earlier availability copy.
The complete static inventory is
`/Volumes/PRO-G40/Projects/Lovelies/verification/ios-grouped-ui-round7-20261025/localization-inventory-complete.json`,
SHA256 `ba7f1bc249fda3abf172dbe9b119614c78747202380810ea6cd82d2e1aded36b`.
The earlier counts and 157/665 execution records below are historical snapshots;
this inventory does not create new semantic, spoken or whole-locale runtime proof.

Both native apps now use English/Kinyarwanda resources for app-owned UI, accessibility, controller/camera messages, help and known displayed statuses. User/provider names, filenames and protocol/state identities retain their meaning. Matching eligibility remains distinct from photo access; consent, fresh capture, exact recipient approval/acceptance, deletion confirmation and store entitlement boundaries are unchanged.

The original Android snapshot had **903 strings and17 plural resources** in each language. The manifest declares English and Kinyarwanda through `locales_config.xml`; the actual Debug APK readback contains both. Android13+ app-language settings use the declared locale list; see [Android's platform guidance](https://developer.android.com/guide/topics/resources/app-languages). Other dependency languages are filtered from this app's supported resource set. That Debug app/test packaging passed **157 fresh unit tests in14 suites**, including missing/null title fallback versus an actual supplied title named Photo.

iOS has **929 static strings,13 Localizable plural dictionaries,7 CountCopy dictionaries and3 system permission descriptions** per language. The project wires both localized variants, and the actual unsigned Release bundle contains en.lproj/rw.lproj. Release and Debug build-for-testing pass with unchanged frozen inputs. All665 focused recovery/authentication/consent/deletion host checks pass after generated-label and known-status presentation changes; unknown codes remain verbatim.

Resource-only Foundation execution passes1858 static lookups,6 permission lookups,144 plural outputs and42 native interpolation outputs, with user/provider arguments preserved. The same cases pass on the actual packaged Release resources; these are repeated cases, not additional distinct coverage. XML/AAPT2 compilation and plist parsing pass. Independent semantic reviews corrected nine Android and twelve iOS phrases; alternate valid wording and terminology uncertainty are preserved.

These checks establish resource integration and local technical behavior. **Q02 still requires actual English/Kinyarwanda journey, long-name, zero/one/many, enlarged-text/Dynamic Type and screen-reader rendering checks.** No native-speaker certification or complete locale/runtime acceptance is claimed. Current iOS reference review is finding and correcting layout/AX defects on an explicitly preserved older08a app; that evidence is not a runtime pass for this newly compiled app. Connected/provider/store acceptance remains separate.

The local source, review, input/output bindings, raw failures and compiled-bundle receipts are preserved under `verification/supabase-release-20261023/localization-root/`, `native-localization-host-final/` and `native-localization-build/`. [Portable verification summary](../verification-summary.json) records their hashes. [rw-resource-draft.json](rw-resource-draft.json) is the preserved historical211-Android/seven-iOS draft; its earlier checks and report-parser failure are provenance, superseded by the broader integrated resources above.
