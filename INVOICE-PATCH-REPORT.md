# Invoice editor patch report

## Applied
- Prevented Enter from implicitly submitting price/discount/type fields; added keyboard navigation for product/service suggestions.
- New invoices only offer `draft` and `issued`; draft creation disables payment input, validates it as zero, and forces a zero payment/status of `draft`.
- Fixed stale catalog selection UI and added a manual-item badge plus an explicit selection-change action.
- Fixed whole-Rial input normalization so a decimal suffix is not concatenated into a larger amount; whole-Rial inputs use `inputmode=numeric`.
- Added `visualViewport`-aware sticky footer positioning and listener cleanup on close/navigation.
- Compact invoice rows, quantity +/- controls with long-press repeat, row total display, hidden row-discount controls, stock hints, and footer row-add action.
- Added inline row validation and inline stock-shortage highlighting.
- Added searchable customer/project pickers (project results filter to the selected customer), recent-customer ordering, and invoice number preview.
- Added 24-hour local draft recovery with 500 ms throttled autosave and a recover/discard choice.
- Added “ثبت + بعدی”, carrying the selected customer/project forward while advancing the local invoice sequence.
- Added a submitting spinner/disabled state with guaranteed restoration on validation errors and save failures.
- Reset the global discount value when changing amount/percentage mode.
- Updated the service-worker cache key so the patched files replace the cache-first PWA assets.
- Added deterministic unit tests for the invoice patch.

## Files changed
- `dia_v27/js/views/invoices.js`
- `dia_v27/js/utils.js`
- `dia_v27/css/style.css`
- `dia_v27/sw.js` (cache version bump required for cache-first PWA updates)
- `tests/run-all.sh`
- `tests/unit-invoice-patch.mjs`

## Preserved
No edits to `finance.js`, `inventory.js`, `db.js`, `validators.js`, `invoice-engine.js`, `router.js`, `components.js`, or `css/print.css`.

## Verification
- JavaScript syntax check: passed for all app JS files.
- Deterministic unit suites: Phase 1 38/38, Phase 2 75/75, Phase 3 10/10, Phase 4 suite passed, invoice patch 10/10.
- Browser E2E: not run because Playwright is not installed. A Chromium headless attempt failed during GPU process initialization in this environment; this is not counted as a pass.
- Real iPhone 11 / iOS Safari test: not performed in this environment.

## Remaining manual/product checks
- The small “+ مشتری جدید” modal and optional top-product chips were not added; customers/projects are searchable but creation still uses the existing customer workflow.
- Browser E2E and real iPhone 11 keyboard/visualViewport verification could not be completed in this sandbox.
