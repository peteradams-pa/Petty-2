# Petty Cash Manager (Offline-First PWA)

A complete, installable Progressive Web App for managing a local petty cash
fund — ledger, reconciliation, controls, analytics, and Excel/backup
import-export — with **zero backend**. Everything is stored on-device in
IndexedDB.

## Quick Start

No build step, no npm install, no server required.

**Option A — Double-click**
Open `index.html` directly in Chrome, Edge, or Firefox. The app loads
Tailwind, Dexie, SheetJS, and Chart.js from CDN and runs immediately.
(Full offline support and installability require Option B, since Service
Workers need `http://` or `https://`, not `file://`.)

**Option B — VS Code Live Server (recommended)**
1. Open the `petty-cash-pwa` folder in VS Code.
2. Install the "Live Server" extension if you don't have it.
3. Right-click `index.html` → "Open with Live Server".
4. The app opens at `http://127.0.0.1:5500` (or similar). The Service
   Worker registers, the app becomes installable (look for the install
   icon in the address bar), and it will keep working offline afterward.

**Option C — Any static file server**
```bash
cd petty-cash-pwa
python3 -m http.server 8080
# then open http://localhost:8080
```

Once loaded over `http`/`https` at least once with a network connection,
the app is fully cached and continues to work with no internet connection.

## Directory Structure

```
petty-cash-pwa/
├── index.html          # App shell — CDN script tags + mount point
├── manifest.json        # PWA manifest (installable app metadata)
├── sw.js                 # Service worker — offline caching + update detection
├── js/
│   ├── db.js             # Dexie/IndexedDB schema and data-access functions
│   ├── app.js             # Main SPA controller — routing, views, forms
│   ├── excel.js            # SheetJS import/export + printable vouchers
│   ├── charts.js            # Chart.js dashboard visualizations
│   └── crypto-helper.js      # Optional AES-GCM encryption for receipt images
└── icons/                       # App icons (SVG, installable-PWA compliant)
```

## Core Features (as specified)

- **Ledger**: Inflows, Outflows, and Advance/IOU transactions with full field
  set (voucher ID, payment method, category/subcategory, GL code, receipt
  image, status, approver/handler).
- **Auto-generated Voucher IDs**: `PC-YYYYMM-XXXX`, sequential per month.
- **Float & Reconciliation Engine**: live balances per channel (cash /
  mobile money / bank), interactive denomination counter with automatic
  variance highlighting against the system cash balance.
- **Controls**: configurable soft/hard spend caps, low-float reorder-point
  alert, same-payee frequency/split-transaction flag, custody handover log.
- **Import/Export**: styled `.xlsx` export (auto-filter, frozen header,
  totals row), filtered exports (date/category/payee/method), full
  JSON database backup & restore, printable HTML→PDF vouchers, and an
  Excel/CSV import wizard with column mapping and voucher-ID de-duplication.
- **Analytics**: KPI cards (balance, monthly spend, pending receipts, net
  variance) plus category breakdown, daily spend velocity, and payment
  channel charts.
- **UI**: Material Design 3–styled Tailwind interface, responsive sidebar
  (desktop) / bottom nav (mobile), FAB for instant transaction entry, dark
  mode, toast notifications.

## Bug Fixes (this update)

A functional audit found and fixed the following issues:

1. **Ledger not syncing with new entries (critical).** The transaction form
   never had a Date & Time field, so every new transaction was saved with
   `date: undefined`. Dexie's IndexedDB indexes silently exclude a record
   from `orderBy('date')` queries when the indexed field is undefined —
   so new transactions were being written to the database correctly but
   never appeared in the Ledger, the Dashboard's recent list, or any
   date-range filtered export. Fixed by adding a required Date & Time field
   to the transaction form (defaulting to "now").
   **Data recovery**: a one-time repair now runs automatically on startup
   that finds any transaction already stuck in this state and backfills its
   date from its original `createdAt` timestamp, so previously "lost"
   entries reappear. You'll see a toast the first time this runs if it
   found anything to fix.
2. **Category editor was incomplete.** There was no way to add or edit a
   category's subcategories at all — only the top-level name and GL code
   were editable. Added a "Subcategories, comma separated" field to each
   category row in Settings, and gave newly added categories unique default
   names to avoid accidental collisions.
3. **Voucher ID collisions after deleting a transaction.** IDs were
   generated from the count of transactions in the month, so deleting a
   transaction and then adding a new one could reissue an ID that still
   existed. Fixed to generate IDs from the highest existing sequence number
   in the month instead of the row count.
4. **Reconciliation balance could silently drop a transaction.** Balance
   calculations skipped any transaction whose status was set to
   "Overdue IOU" unless its type was also "Advance IOU" — but the Status
   field allows "Overdue IOU" on any transaction type. That combination
   made the transaction vanish from the float total entirely (neither
   added nor subtracted), silently corrupting reconciliation. Status now
   only affects documentation follow-up, never whether a transaction counts
   toward the balance.
5. **Offline caching missed the CDN libraries.** The service worker only
   cached responses with `status === 200`, but cross-origin `<script src>`
   requests (Tailwind, Dexie, SheetJS, Chart.js) come back as "opaque"
   responses that always report `status: 0`. They were never actually being
   cached, so a fully offline load could fail to render. Fixed to also
   cache opaque responses.

## Visual Design Revamp

The UI was rebuilt on a proper design system rather than default Tailwind
grays:

- **Typography**: Inter for body text, Lexend for headings — a more
  distinctive, modern feel than the system font stack.
- **Depth & surfaces**: a shared `.card` style (soft layered shadows,
  1.75rem corners) replaces 17 copies of the same inline class string, so
  the whole app now shifts consistently if the look changes again. A
  subtle radial gradient wash (tinted with whichever accent color is
  active) replaces the flat gray background.
- **Motion**: pages fade/slide in on navigation, modals pop in on desktop
  and slide up as a native-feeling bottom sheet on mobile, and buttons
  give a tactile scale-down on tap.
- **Iconography**: KPI cards, section headers, and empty states now use
  colored icon badges instead of a bare emoji floating in a corner.
- **Ledger on mobile**: replaced the cramped horizontally-scrolling table
  with a proper card list on small screens; the full table remains on
  desktop where there's room for it.
- **Settings**: accent color swatches now show a checkmark on the selected
  color instead of a resizing border, and the light/dark toggle is a
  proper segmented control.
- **Charts**: Chart.js now inherits the app's font, and the line/bar/donut
  charts use thicker strokes, hover states, and rounded bar corners for a
  less "default library" look.

## Autonomously Added Features

The brief granted explicit engineering autonomy to add anything that would
make the app more robust or complete. The following were added beyond the
literal spec, and why:

1. **Full audit trail** (`auditTrail` table in `db.js`) — every create,
   update, delete, import, restore, settings change, and custody handover is
   timestamped and logged. Petty cash is a common fraud/error surface;
   an audit trail is standard financial-controls practice and costs almost
   nothing to add.
2. **Receipt image compression** — uploaded receipt photos are downscaled
   and re-encoded via an in-browser canvas before being stored (max 1024px,
   JPEG quality 0.72). Raw phone photos can be several MB each; without
   this, IndexedDB storage would balloon quickly on a device logging dozens
   of receipts a day.
3. **Optional encryption-at-rest for receipts** (`crypto-helper.js`) —
   AES-GCM with a key derived (PBKDF2, 100k iterations) from an app PIN.
   The key lives only in memory for the session and is never persisted.
   This is opt-in because it requires the PIN to always be entered
   correctly to recover images — appropriate for sensitive expense
   documentation, but not forced on users who just want quick offline
   logging.
4. **App PIN lock screen** — a lightweight local lock so a phone left
   unattended doesn't expose the ledger. Pairs with the encryption feature.
5. **Dark mode toggle** — persisted per-install, respects the Material You
   guidance already requested for the light theme.
6. **Keyboard shortcuts** — `N` opens a new transaction, `1`–`5` jump
   between views, `Esc` closes modals. Meaningful time-saver for someone
   logging many vouchers a day at a desk.
7. **PWA update toast** — when a new Service Worker version is detected,
   users get a non-blocking "reload to update" toast instead of silently
   running stale cached code indefinitely.
8. **Live, in-form spend-cap warning** — the amount field warns (or blocks,
   in hard-cap mode) *while typing*, before the voucher is even submitted,
   rather than only after the fact.
9. **Auto-column-guessing on Excel import** — when mapping an uploaded
   sheet's columns, the importer pre-selects likely matches by header name
   (e.g. a column literally called "Amount" auto-maps to the Amount field),
   so the user usually only needs to confirm rather than map from scratch.

## Data & Privacy

All data — transactions, settings, custody logs, audit trail, and receipt
images — is stored **only** in this browser's IndexedDB on this device.
Nothing is transmitted anywhere except to the public CDNs used to load the
Tailwind/Dexie/SheetJS/Chart.js libraries themselves. Use the full-backup
export regularly, since clearing browser data will remove the ledger.
