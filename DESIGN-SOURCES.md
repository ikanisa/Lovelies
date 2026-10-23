# Screenshot implementation sources

The owner's current direction is to reproduce every supplied Lovelies screenshot. The 48 PNGs in `Lovelies-48-Screen-PNGs/screens/` are the direct visual targets, indexed in the original CSV/manifest and `shared/catalog.json`.

The sole product design skill is **Revolut Design from Jean Bosco Skills**, provider `revolut-design@jean-bosco-skills`. Skill discovery was unavailable, so the maintained source entrypoint was read at `/Volumes/PRO-G40/Projects/ChatGPT/Revolut/skill/revolut-design/SKILL.md`, together with its brand, typography, mobile and screen-family guidance. The user's screenshot-specific instruction controls the black/pink Lovelies treatment and each route's composition. No Revolut branding or financial workflows enter the product.

Screen families follow the supplied boards:

| Source screens | Included views |
| --- | --- |
| 01–09 | Splash, introduction, sign in, access options, enrollment, retry, processing, setup complete |
| 10–18 | Home, new matches, viewer, photo library, favorites, search, filters, activity, notifications |
| 19–24 | Upload entry, source picker, selection, review, progress, complete |
| 25–36 | Matching summary, gallery, photo/person views, selection/deselection, sharing review, progress, history, report |
| 37–48 | Profile, face management, recipients, privacy, access, notifications, storage, export, help, security, empty, offline |

`scripts/extract-reference-assets.py` extracts the owner's handwritten wordmark, photo/heart illustration, photographic regions and avatars. The original PNGs are read-only inputs; the manifest binds each crop to its source hash. Artwork is shared between the two native apps and the review companion. Whole screenshot images are used only as review comparators, never as interactive app screens.

`shared/home-grid.json` describes the measured 16-photo Home arrangement. `shared/reference-grids/layouts.json` describes individual source rectangles on screens 11, 14, 15, 21, 26, 28, 29, 30, 33, 37 and 38. Its manifest binds 103 individual crops to their source bytes and records native overlay locations for selection, favorite and people controls. Screen 38 uses Jasmine's own camera image and four face variants. `scripts/extract-reference-art.py` separately extracts eight noninteractive collage/hero illustrations; the text and actions around them remain real controls.

The supplied boards contain repeated and partial photograph variants. Screen 33's two hat portraits are two presentations of one demo photo, yielding seven rectangles and six selected IDs. Screen 26's partial city/cathedral fragments use two existing demo IDs, yielding fourteen rectangles and twelve photo IDs; their underlying identity is a documented fixture assumption. Screens 29 and 30 keep the group image and its two-woman crop independently selectable because their supplied selection marks differ. The manifests retain these reconciliations. Selection counters count actual demo IDs; normal edited reviews must retain their chosen photograph variants.

The source crops have limited resolution, varying aspect ratios, and no supplied font files. System fonts, platform status bars, usable touch targets, scrolling and safe areas are adaptations. The source enrollment illustration already includes face guides; it is a fixture rather than a camera feed. Supplied screenshot layouts are the target; no pixel-equivalence or platform acceptance is implied by creating the source mapping.
