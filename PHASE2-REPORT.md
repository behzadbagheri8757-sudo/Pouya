# DIA Business — Phase 2 report (V2.9)

Patch on top of V2.8 Phase 1. No rewrite, no UI redesign. All Phase 1 invariants kept (38/38 Phase 1 unit tests still pass; Phase 1 E2E suite unchanged except one cache-name expectation).

## Files changed
New: `js/inventory.js` (inventory domain rules), `js/views/payment-modal.js` (receive / allocate / refund workflows), `js/views/stock-modal.js` (movement + history UI), `tests/unit-phase2.mjs`, `tests/e2e-phase2.cjs`, `tests/run-all.sh`.
Modified: `js/db.js`, `js/finance.js`, `js/utils.js`, `js/app.js`, `sw.js`, `js/views/{invoices,products,projects,customer-detail,customers,services,dashboard,accounting,reports,settings}.js`, `tests/e2e.cjs` (only the SW cache-name expectation).

## DB / schema changes
- IndexedDB version 2 → 3. New stores: `stockMovements` and `paymentAllocations`, both with a UNIQUE `key` index (DB-level idempotency).
- Backup `dataVersion` 1 → 2 (file `version` stays the DB version, now 3). Both new stores are required in dataVersion ≥ 2 backups.
- New transaction type `customer_refund` (cash out to customer; not an expense). New optional fields: `receiptKey`, `refundKey` on transactions; `stockTracked` on invoices.
- `products.stock` is kept, but is now a CACHE of the movement ledger.
- `DB.atomic` now supports chained writes (`bindKey` / `bind`) so a new payment and its allocations commit together. `saveInvoiceWithPayment` also writes stock movements in the same transaction.

## Migrations
1. Stock ledger (`stockLedgerV1`, runs once, serialized with the Phase 1 migrations): every product with non-zero legacy `stock` and no movement gets ONE `opening` movement equal to it. `products.stock` is never altered; re-runs add nothing.
2. Legacy invoices are NOT retro-booked (would silently change hand-maintained stock). They stay untracked (`stockTracked` absent) until re-created.
3. Restoring a dataVersion-1 backup builds the opening ledger inside the same restore transaction. A V2.7-era backup (Toman) still goes Toman→Rial first, then builds the ledger from converted prices.
4. Legacy `paidAmount` payments and `project.cost` keep their old meaning (shown as "legacy/manual cost" separately from expenses and inventory cost).

## Business rules added
- Stock: ledger is truth; issued/partially_paid/paid invoices book stock-out of product lines; draft/cancelled net 0; edits book only the delta; cancel reverses exactly what is booked (once); reopening re-books with a fresh unique key; services/manual lines never move stock.
- Insufficient stock: rejected with a message listing each short product (`STOCK_POLICY.allowNegative = false`, one place).
- Invoices that touched the ledger are never hard-deleted (cancel instead). Sales return (stock-in) is bounded by quantity sold; edits below returned quantity are rejected.
- Product form stock edits become `opening`/`adjustment` movements, never a blind overwrite. Manual purchase, adjustment and project consumption/return movements exist.
- Allocation: an on-account payment can be split across invoices; caps enforced (payment amount, invoice remaining, same customer, not cancelled/draft); idempotent by key; allocation never changes customer balance or total received (no double counting). Payment linked to an invoice keeps its Phase 1 meaning.
- Receive payment modes: account (Phase 1 cap), one invoice, multiple invoices (remainder stays credit), advance.
- Refund: explicit transaction; original payment untouched; reduces invoice net paid (status/remaining move back), project received, dashboard/report received (net); debit row in customer ledger; capped by invoice net paid / customer credit / cash; idempotent by `refundKey`.
- Projects: `projectFinancials(project, invoices, transactions, movements, allocations)` adds `inventoryCost`, `manualCost`, `grossReceived`, `refunded`; costs = expenses + manual + inventory (each counted once); payment is never profit.

## UI
Customer page: quick actions (new invoice, receive payment, statement, open invoices), credit badge, allocate-credit, refund. Dashboard: 6 quick actions opening the existing forms (deep links `?new=`). New project detail page `#/projects/:id`. Products: stock-movement and history buttons. Invoice detail: refund and goods-return buttons. Reports: projects, inventory movements, allocation/refund reports; income report and customer statement are net of refunds.

## Tests added
- `unit-phase2.mjs`: 74 test cases (75 assertions counted by the runner) covering legacy migration, opening stock, purchase, invoice stock-out/edit delta/cancel/reopen/duplicate/insufficient/legacy/sales return, project cost, allocation (one→one, one→many, partial, over-allocation, credit, cancelled invoice, legacy), refunds (partial, full, idempotent, ledger, dashboard, not expense), project financials, backup validation (new stores, old backups, bad ledger).
- `e2e-phase2.cjs`: 20 browser tests (real IndexedDB) incl. v2→v3 upgrade, UI invoice stock flows, double-tap, payment/refund UI, quick actions, project page, reports, backup round trips (Phase 2, Phase 1, V2.7), DB-level duplicate protection, every route without JS errors, print/image buttons.

## Results (exact)
- Phase 1 unit: 38 passed, 0 failed. Phase 2 unit: 75 passed, 0 failed.
- Phase 2 E2E: 20 passed, 0 failed (two consecutive runs).
- Phase 1 E2E (41 tests): patched runs gave 39, 40 and 40 passed; the only failures were 05a/05b/05c/10a. These same tests fail intermittently on the UNTOUCHED original code in this sandbox (original run: 38/41, failing 05b, 05c, 10a). They are fixed-timeout form-fill races, not regressions. I did not get a single 41/41 patched run, so this is not a clean pass; fixing those waits is a recommended follow-up.
- All routes render without JS errors; offline/PWA test passes.

## Remaining work / not done
- Purchase-from-supplier is a stock movement only; it does not create a supplier payable or expense (record the expense separately).
- Allocation UI exists for new payments and for unallocated credit; there is no UI to reverse an allocation (rules support none by design).
- Project-consumption cost uses the unit-cost snapshot on each movement; project invoices do not auto-book consumption.
- Legacy invoices are untracked by design; no bulk "start tracking" tool.
- Stock history modal has no filters (the inventory report does).
- Not tested on a real iOS device; Chromium only.
