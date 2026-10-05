# Hall pricing library for the meeting

The user-authorized import on 3 October 2026 saved the supplied `p-db` snapshot's pricing into the local demo database. Open `http://localhost:4200/planner/pricing`, or use **Layouts → Pricing & EMC → Browse hall pricing library**.

## Saved coverage

| Data | Count |
|---|---:|
| Source stall-price records | 105 |
| Source event IDs | 9 |
| Mapped stall hall/location IDs | 27 |
| New editable price masters | 81 |
| Reference-only stall-price records | 24 |
| Hall/location rental entries | 47 |
| Rental schedules across four categories | 8 |

All 105 records are retained in the library, including incomplete mappings, F&B and test-event records. The 81 eligible domestic records are also editable price masters. The original `finance` master remains unchanged; there are 82 masters in total after import. No layout, booking or published quote was changed.

Stall rates remain separated by source event, event hall, category and date window. Hall 12 and Hall 12A are distinct: the IITF 2026 General three-side premium is 20% for Hall 12 and 15% for Hall 12A. The Hall 12A General master has bare ₹17,100/m², shell ₹17,600/m² and catalogue ₹0, with its original 2026-09-14 through 2026-10-31 applicability window retained in the library/name.

## Meeting use and limits

- Choose an event, hall and category in **Stall rates**. Expand **Editable master** to find its saved name. Select that name in the existing Pricing & EMC editor to edit or apply it explicitly.
- Imported masters are labelled **pre-tax**: tax mode NONE and tax/EMC amounts zero. The source has no complete tax or EMC policy. Do not present these as approved final charges.
- Date/category matching is manual. The library displays source amounts; editing a price master does not rewrite the original source library.
- Reference-only records explain the missing mapping, unconfirmed basis or other exclusion. F&B source fields are not treated as per-m² rates. Overseas values are preserved without inventing a currency.
- **Hall rentals** has 47 locations, linked to category-level Peak/Lean schedules. Billing units require confirmation. Source additional-charge and discount percentages are displayed but not automatically applied.
- Some Peak schedule end dates precede their start dates. The UI flags this source inconsistency without correcting it or assuming recurring seasons. Historical/inactive/test records remain labelled as such.

## Import and persistence

Migration `1791040000000-PricingLibrary` creates `pricing_libraries` with a source hash and JSONB catalog. `GET /api/price-masters/library` returns the saved `p-db-demo` catalog with import timestamp, or null before import. Startup runs the migration with `synchronize` still disabled.

The importer reads only `T_STALL_PRICE_MASTER`, `T_EVENT_HALL`, `T_HALL_BOOKING`, `T_HALLS`, `T_HALLS_PRICE` and `T_HALLS_CATEGORY` from the custom PostgreSQL dump. It runs `pg_restore` to emit selected table text, parses COPY data, and never executes dump SQL or restores the source database. The emitted catalog retains pricing fields and selected event/hall metadata, not contact or exhibitor records.

Preview from the backend project:

```powershell
node --env-file=.env -r ts-node/register scripts/import-pricing-library.ts '--dump=C:\Users\Shivam Sharma\Documents\p-db'
```

Add `--apply` to save to the configured local database. The script rejects remote database hosts. One transaction/advisory lock creates masters and upserts the library; source-ID ownership enables reruns without overwriting editable masters. Conflicting names outside the imported set are rejected. A repeat apply retained all 81 masters and created zero duplicates. The count/hash report is `scripts/data/pricing-library-import-result.json`.

Source SHA-256: `55801179dc90a5e3afe29b9f063feb266111d805aec9aae18309e9df828d9452`.

## Validation

- Backend typecheck and 26 pricing unit tests passed, including COPY decoding, null/zero preservation, mapping exclusions and premium values.
- Frontend development build and six library tests passed, including Hall 12 vs Hall 12A isolation, filter resets, reference-only availability, retry and reversed-date warnings.
- Browser verification covered saved masters, reference-only F&B, hall rentals and mobile selection/focus at 1440, 1280 and 390-pixel widths. The 390/1280 views had no horizontal overflow.
- API verification matched every one of the 81 library master IDs to a saved master and confirmed the original `finance` rate was unchanged.
- Fresh UI finish review returned **ship**, with no material fixes. The reviewer used Impeccable's degraded reviewer contract in a separate subagent because this harness did not load a specialized reviewer role. Valid viewport captures plus detail-region captures were used after full-page screenshot stitching proved unreliable.
