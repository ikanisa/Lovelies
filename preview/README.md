# Lovelies clickable screen review

Open `/preview/index.html` through a static HTTP server rooted at the Lovelies workspace. The coordinator owns the server and browser verification. The review has no dependency install or build step: `index.html`, `styles.css`, and `app.js` are editable browser source.

The 48 renderers are reconstructed HTML controls, lists, layouts, SVG icons and image elements. The app surface never displays a flattened UI screenshot or uses screenshot hotspots. The **Compare** control shows the corresponding original separately, outside the interactive screen. The screen catalogue, previous/next controls, and URL fragments (`#10` or `#screen=10`) make every reference screen directly accessible. Browser back and forward work. iOS/Android switches preview chrome and labels the corresponding native implementation source; this browser companion is not a native executable.

Visual evidence is the supplied `Lovelies-48-Screen-PNGs/screen-index.csv` and its 48 unchanged PNGs. The original captures are small (214–259 px wide), with varying aspect ratios and apparent composite/crop framing. The comparison column preserves each original. The interactive phone reflows at its available width and viewport height, with readable text, minimum 44px controls and scrolling; it does not scale the whole interface. Photo grids use the retained individual crops in usable masonry or narrow layouts. Enlarged text may stack navigation, tabs, metadata and header titles. The source's black surfaces, pink glow, Lovelies handwritten mark, content and workflows control this specific request. The sole design skill used is the maintained `revolut-design@jean-bosco-skills` source at `/Volumes/PRO-G40/Projects/ChatGPT/Revolut/skill/revolut-design/SKILL.md`. That skill's own-identity and mobile interaction guidance is applied within the user's explicit screenshot direction.

`../shared/assets/` contains the supplied photography, own wordmark, photo-heart artwork, bokeh backdrop and portraits cropped from the retained originals by the asset owner. These are content assets. Faces remain synthetic demo identities as depicted in the supplied design. These low-resolution crops limit photographic sharpness and exact reconstructed typography; the review is available for direct comparison and does not assert measured pixel equivalence.

Home uses the 16 exact individual source-screen-10 photographic crops (`home01.jpg`–`home16.jpg`) and the normalized cell rectangles in `../shared/home-grid.json`. Each is a separate real button/image inside the rebuilt gallery, with independent hover/focus, a stable photo ID and a viewer action. No flattened screen image is used in the interactive Home. A chosen Home cell also supplies its photography to the viewer and people drill-down; directly browsing reference screen 12 or 27 restores that screen's illustrated hero.

Screens 11, 14, 15, 21, 26, 28, 29, 30, 33, 37 and 38 use individual original-resolution photographic crops and reference metadata from `../shared/reference-grids/layouts.json`. The 103 crop assets have source SHA256, original crop coordinates and output SHA256 recorded in `asset-manifest.json`; `extract.py` reproduces their extraction without modifying or enlarging the originals. Insets for selection/favorite controls and people badges are normalized relative to each photo. Actual stateful controls cover baked source markers with opaque backing, including after deselection. Screen 30 reuses bright screen-29 photography with DOM dimming. Search/filter results and changed profile categories retain their working local models. Screen 38 uses the supplied Jasmine camera photo and four own-face variants rather than unrelated people.

Source-specific reconciliation is explicit: screen 33's seven photographic rectangles represent six logical photo IDs; the hero and upper-right hat portrait are two supplied crops/variants of ID 1 and filter together. This seven-rectangle composition is used only for an explicit reference-screen visit. Ordinary review flows render the actual selected image URLs from their selection stage, preserving photo identity through Edit and Continue. Screen 26's partial bottom city/cathedral fragments use existing logical IDs as documented presentation assumptions, while retaining their exact source crop bytes. Screen 21 uses the 14 visible cells and local below-crop sample cells so its source “12 selected” state and scrolling/deselection remain operable; the supplied crop does not establish unseen photo content.

The noninteractive illustrations on 2, 8, 9, 24, 25, 34, 47 and 48 use separately extracted, source-sized artwork from `../shared/reference-art/`. All headings, body text, navigation, progress models, fields and buttons remain actual HTML. Original screenshots remain confined to the optional comparison column.

Implemented local journeys:

- Onboarding, photo-access choices and three simulated selfie poses; retry and processing/completion routes.
- Photo viewing, people drill-down, favorites, categories, text search and filters.
- Activity and notification category tabs.
- Upload source/album/camera choice, photo selection, editable caption, album/visibility review, deterministic progress and completion.
- Screen 20 also offers Google Photos, Google Drive, iCloud Photos (iOS only), Dropbox and OneDrive in a grouped, scrollable source picker. These choices open the local sample photos; the selected provider stays visible through selection and upload review. They do not connect an account or import provider media.
- Photo and recipient selection/deselection, editable review, zero-selection disabled controls, deterministic sharing progress and history.
- Match reports, editable profile, face management, matched people allowed by default with Block/Unblock controls, privacy and notification switches. Allowed derives from the eight current matched demo identities minus blocked people; the three historical blocked sample records remain in the blocked directory. Blocking removes the person from the current share selection; unblocking makes them eligible for future shares when matched and does not restore selections or previous photo access. Each share still needs its photo/recipient review and approval.
- Profile discoverability starts at Anyone, with Only matched people and Allowed people only retained as selectable choices. The chosen value and visible selection persist through local navigation and rerenders; a full reload resets demo state. Discoverability does not change photo visibility or sharing approval.
- Storage cache clearing, local export-request state, searchable help, support-request draft, account-detail editing, two-factor setting and device removal.
- Confirmed sign-out and preview-account reset, no-match and offline recovery routes.

All account, camera, upload, sharing, permission, support and export states are **local front-end demo state**, identified visibly outside the device. No authentication, system permission, network upload, external delivery, external message or filesystem write occurs. State lives in memory and resets on a full page reload. Browsing the reference catalogue restores the illustrated default selection for screens 21, 29–35; following in-app controls preserves the user's current selection. Choosing Edit from Review and Share preserves the selection across both editors.

Stable inspection hooks:

```js
window.loveliesPreview.go(33); // Browse screen 33 in its illustrated reference state.
window.loveliesPreview.go(33, { referenceState: false }); // Preserve edited flow state.
window.loveliesPreview.screen; // Current screen number.
window.loveliesPreview.state; // Local model; selection fields are Sets.
window.loveliesPreview.selectPhoto(1);
window.loveliesPreview.selectPerson(1);
window.loveliesPreview.reset();
```

`#device[data-screen-id]` identifies the current surface. Controls carry `data-action`; selectable photos and people have `data-id` and `aria-pressed`. Main actions are `select-photo`, `select-person`, `select-upload`, `favorite`, `capture`, `upload-start`, `share-start`, `go`, and `browse-screen`. Text fields carry `data-input`; native toggles/radio choices carry `data-setting` and, for grouped toggles, `data-key`. Original screenshots are loaded solely into `#reference-image`.

Validation owned here: `node --check preview/app.js`. Rendered visual, browser interaction and native build verification belong to the coordinating agent. Written renderers do not alone establish exact screenshot fidelity, native device behavior, provider integration, release signing or store acceptance.


## Accessibility and navigation review, 23 October 2026

All 48 interactive routes have named controls and usable exits. Secondary Back/Close/Cancel actions return to their actual origin with a parent fallback for direct catalogue entry. Browser Back/Forward preserve route state and use the appropriate transition direction; completed progress screens are retired from the ordinary return path. In-route updates preserve focus and scroll; route changes focus a heading, dialogs return focus to their opener, and keyboard-submitted forms execute their save action. The compact catalogue behaves as a keyboard-contained dialog with Escape dismissal.

Normal reference navigation has a short directional transition, buttons provide press feedback, and the system reduced-motion preference removes animations/transitions. Progress and search results provide polite status feedback. Images inside named actions are decorative to screen readers; selection and toggle states remain explicit.

Observed browser coverage and saved screenshots are in `../verification/accessibility-navigation-20261023/README.md`. Native source fixes and combined build receipts are separate from browser proof. Spoken VoiceOver/TalkBack, iOS runtime Dynamic Type/landscape and connected provider journeys require their own observed evidence.
