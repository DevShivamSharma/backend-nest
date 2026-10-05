# Phase 2: configurable pricing and EMC charges

Started 3 October 2026 after the user selected **editable rates/markup**. This is the first Phase 2 milestone; it does not complete the remaining EMC permissions, payment integration, CAD work or deployment.

## Use the feature

1. Open the planner's **Layouts** tab and scroll to **Pricing & EMC**.
2. Choose **New master**, enter an approved bare and/or shell rate, premiums, tax mode and any EMC charges. Blank bare/shell rates mean unavailable; numeric zero means free. The engine does not seed commercial rates automatically. The later user-authorized `p-db` demo import is documented in [Hall pricing library](pricing-library-demo.md).
3. Alternatively, download the Excel template, fill the `Price masters` sheet, select the workbook and review every imported column before importing. Use the horizontally scrollable preview for all charges/taxes. Imports create new masters; they never silently overwrite existing names.
4. Save/open a layout, choose a saved price master and **Apply rates to layout**. The applied revision is copied into the layout and its state becomes Draft. Unsaved editor geometry is preserved. Update the layout before previewing changed geometry.
5. Calculate a saved stall's price, then use **Review & publish**. Exhibitors choose bare/shell space, review the server-generated breakdown and confirm the total before booking.

Error feedback receives focus and scrolls into view without discarding entered values. Its action returns to the relevant form/import or retries the relevant request.

## Calculation contract

- INR only. Base rates are per square metre; catalogue and fixed EMC charges are per stall.
- The existing SelfCare formula remains the source of base rental, open-side premium, catalogue and tax. Custom stalls use polygon area, rounded to two decimals as in the existing booking contract; custom open edges determine the premium tier (4+ edges use the four-side tier).
- Decimal multiplication rounds half-up to paise without a floating-point intermediate product. Each charge/tax line is rounded separately.
- EMC charge = percentage of **rental + open-side premium + catalogue, before tax**, plus fixed EMC charge. EMC tax is zero unless the user explicitly enables the selected tax rates for EMC.
- Tax mode is explicitly NONE, CGST_SGST or IGST. Contradictory percentages are rejected. No tax treatment is inferred from location, identity or legal status.
- SelfCare payload amounts remain the base amounts. The separate `quote` receipt includes EMC charge, EMC tax and the combined total. There is no external SelfCare write or payment collection in this milestone.

## Persistence and API

Migration `1791030000000-PricingMasters` adds `price_masters`, `layouts.pricing_policy` and `stalls.booking_quote`. Normal startup runs pending migrations; `synchronize` stays disabled. The down migration removes pricing data and must not be used as an ordinary undo operation.

| Route | Behaviour |
|---|---|
| GET `/api/price-masters` | List `{id,name,revision,policy}` records. |
| POST `/api/price-masters` | Create a flat price-master input; unique case-insensitive name. |
| PUT `/api/price-masters/:id` | Body `{revision,master}`; reject a stale revision with 409. |
| POST `/api/price-masters/import` | Body `{rows:[...]}`; validate all rows before one transaction. 1–500 rows. |
| PUT `/api/layout/:id/pricing` | Body `{masterId,revision}`; copy the exact revision and return the layout to Draft. |
| GET `/api/layout/:id/stalls/:number/quote?stallType=bare` | Quote saved geometry and applied policy, or return an existing booking receipt. Shell is also supported. |
| POST `/api/layout/:id/stalls/:number/book` | On priced layouts, require `{stall_type,expectedQuote}` where `expectedQuote` is the reviewed fingerprint. |

Master input fields follow the template: `name`, `bare_rate`, `shell_rate`, `two_side_open_rate_percent`, `three_side_open_rate_percent`, `four_side_open_rate_percent`, `catlog_entry_charge` (SelfCare spelling), `tax_mode`, `cgst_percent`, `sgst_percent`, `igst_percent`, `emc_name`, `emc_markup_percent`, `emc_fixed_charge`, `emc_taxable`.

Bounds: amounts 0–10,000,000 with up to two decimals; percentages 0–100 with up to two decimals; master/EMC names up to 120 characters. Browser workbooks are limited to 2 MB and 500 rows; formula cells and altered headers are refused. The import route alone accepts a JSON body up to 1 MB so 500 normalized rows fit; server row validation remains authoritative.

An applied master snapshot does not change when its master is edited. Reapplication is explicit. Priced booking requires publication, recomputes the quote while holding the same layout lock as editor saves, rejects caller-supplied price/tax overrides, and persists the accepted receipt. A stale quote, stale revision, or second booking receives 409. A stale editor cannot remove, resize, move, reopen or alter the priced frontage of a booked stall. Other layout saves preserve receipts by stable stall number.

Existing layouts without an applied price policy retain their legacy booking contract, including empty-body booking. Newly saved layout copies require explicit price assignment. Existing booked receipts stay unchanged if a newer price master is later applied to the layout.

## Verification

- Existing backend regression suite: 501 passed; three pre-existing skips.
- New pricing unit tests: 21 passed, including unavailable/free rates, invalid values, mixed taxes, decimal rounding, EMC totals, edge premiums and fingerprint changes.
- Pricing API tests: six passed against the dedicated `stall_designer_test` database. These cover import rollback, 500-row import capacity, revision conflicts, snapshot isolation, stale/tampered quotes, concurrent booking and receipt preservation.
- Excel parsing tests: eight passed in ChromeHeadless.
- Final complete frontend unit suite: 341 of 341 passed (including the eight workbook tests).
- Complete browser flow passed at 1440×900 and 390×844 against the real API and isolated test database. Browser test sources: `test/api/pricing-ui.spec.ts`; captures: `test-results/pricing-review/`. The browser suite also exercises a real duplicate-save failure from the bottom of the form, feedback focus and retained inputs.
- A full frontend run exposed a same-millisecond local hall-ID collision; local IDs now include a monotonic suffix and its existing regression test freezes the clock to cover the case deterministically.
- Backend and frontend builds passed. Existing frontend CSS budget and polygon-clipping CommonJS warnings remain.
- UI finish review requested visible error recovery; its final verdict scored that fix resolved and returned `ship` at that limited scope. The final captures include actual failed-save feedback at both widths.

The browser suite needs the Angular development server on port 4200; it forwards API calls to the dedicated test server on 18081 and cleans up only the layouts/price masters it created. It does not modify demo layouts 1093/1094 or seed commercial rates.

## Remaining Phase 2 work

- EMC-specific permissions, price approval workflow and final business policy rules.
- Payment/hold expiry, cancellation/refund workflow, external identifiers and actual SelfCare synchronization.
- Broader CAD UI work and production deployment/authentication configuration.

The existing app remains unauthenticated; this milestone is locally verified functionality, not a production-readiness or tax-compliance claim.
