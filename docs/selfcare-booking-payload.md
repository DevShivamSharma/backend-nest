# Stall booking → SelfCare database payload

`POST /api/layout/{id}/stalls/{stallNumber}/book` books an AVAILABLE stall in the planner and
returns the same booking as rows for the SelfCare (ITPO) portal's tables, under `selfcare`.
Every key is the column name in SelfCare's `idp` schema, so another service can write the rows
as they are. Code: `src/layouts/selfcare-booking.ts`; request body: `src/layouts/dto/book-stall.dto.ts`.

The design follows SelfCare's production schema and data (dump of `production`, PostgreSQL 18.4):
column names, status values and the price arithmetic below were read from it, and the tests
reproduce a real `T_STALL_BOOKING_DETAIL` row to the paisa.

## How SelfCare stores a stall booking

| Table | Role | Key columns |
|---|---|---|
| `T_STALLS` | one row per stall | `id` (uuid), `hall_id` (int), `island_number` + `stall_number`, `booking_status`, `no_of_open_sides` |
| `T_STALL_BOOKING` | one row per booking (header) | `id` (uuid), `user_id`, `event_id`, `booking_code` (`S-` + 11 digits), `booking_status`, `payment_status`, `valid_till` |
| `T_STALL_BOOKING_DETAIL` | one row per booked stall | `booking_id`, `stall_id`, `hall_id`, `event_hall_id`, `stall_type`, `area`, `open_sides`, amounts, `status` |
| `T_STALL_PRICE_MASTER` | prices per hall + event | `bare_rate`, `shell_rate`, `two/three/four_side_open_rate_percent`, `catlog_entry_charge`, `corner_charges_applicable` |

**Stall identity.** SelfCare splits a stall name into `island_number` + `stall_number`: our
"12A-17 A" is island `12A-17`, stall `A`, the same block + letter the PDF import reads.

**States seen in the data.**

| | before payment | paid | timed out | cancelled |
|---|---|---|---|---|
| `T_STALL_BOOKING.booking_status` | `Pending` | `Confirmed` | `Timeout` | `Cancelled` |
| `T_STALL_BOOKING.payment_status` | `Pending` | `Completed` | `Timeout` | `Cancelled` |
| `T_STALL_BOOKING_DETAIL.status` | `In-Progress` | `Booked` | `Cancelled` | `Cancelled` |
| `T_STALLS.booking_status` | `In-Progress` | `Booked` | `Available` | `Available` |

`valid_till` is the hold: in the data it is ~390 minutes after `created_at`, which reads as a
60-minute hold plus the 5 h 30 m IST offset between the two timestamp types (`created_at` has no
time zone). The planner uses 60 minutes in UTC; confirm with the SelfCare team.

**Price arithmetic** (checked against stored rows):

```
rate              = shell_rate or bare_rate (by stall_type)
rental            = area × rate
corner_charge     = rental × {2: two_side, 3: three_side, ≥4: four_side}_open_rate_percent / 100
                    (0 for 0–1 open sides, or when corner_charges_applicable is false)
catalog_charge    = catlog_entry_charge
total             = rental + corner_charge + catalog_charge
cgst/sgst amount  = total × cgst/sgst_percent / 100      (or igst when inter-state)
total_gst_amount  = cgst + sgst (or igst)
net_payable_amount= total + total_gst_amount
```

## What the planner fills in

The planner takes no payment, so it writes the **pre-payment** state (`Pending` / `In-Progress`).
SelfCare's payment flow moves it on, exactly as for its own bookings.

From the planner: `island_number`, `stall_number`, `area`, `open_sides` / `no_of_open_sides`,
timestamps, `valid_till`, the fixed flags (`is_active`, `is_marquee`, …) and the states.

From the request body (optional, SelfCare's own values): `user_id`, `event_id`, `event_name`,
`event_hall_id`, `hall_id`, `stall_id`, `stall_type` (`shell` | `bare`), `product_category_id`,
`pricing` (the `T_STALL_PRICE_MASTER` row) and `tax` (`cgst_percent`, `sgst_percent`, `igst_percent`).
Anything not given stays `null`; amounts are computed only when `stall_type` and its rate are given.

Left to SelfCare: `T_STALL_BOOKING.id` and `booking_code` (its own sequence),
`T_STALL_BOOKING_DETAIL.booking_id` (the new booking's id), TDS and security deposit.

## Example

Request:

```json
{
  "user_id": "…uuid…", "event_id": "…uuid…", "event_hall_id": "…uuid…", "hall_id": 67,
  "stall_type": "shell",
  "pricing": { "bare_rate": 16000, "shell_rate": 17600, "two_side_open_rate_percent": 10,
               "three_side_open_rate_percent": 15, "four_side_open_rate_percent": 18,
               "catlog_entry_charge": 0, "corner_charges_applicable": true },
  "tax": { "cgst_percent": 9, "sgst_percent": 9, "igst_percent": null }
}
```

Reply (`selfcare`, for a 16 m² stall "12A-17 A" with 2 open sides):

```json
{
  "T_STALLS": { "id": null, "hall_id": 67, "island_number": "12A-17", "stall_number": "A",
                "booking_status": "In-Progress", "no_of_open_sides": 2 },
  "T_STALL_BOOKING": { "user_id": "…", "event_id": "…", "event_name": null, "status": "active",
                       "booking_status": "Pending", "payment_status": "Pending",
                       "valid_till": "2026-10-02T11:00:00.000Z", "is_active": true, "is_marquee": false,
                       "is_fnb_stall": false, "is_branding_stall": false, "is_horse_shoe": false,
                       "is_overseas_booking": false,
                       "created_at": "2026-10-02T10:00:00.000Z", "updated_at": "2026-10-02T10:00:00.000Z" },
  "T_STALL_BOOKING_DETAIL": [{
    "stall_id": null, "hall_id": 67, "event_hall_id": "…", "event_id": "…", "user_id": "…",
    "product_category_id": null, "stall_type": "shell", "area": 16, "open_sides": 2,
    "rate": 17600, "rental": 281600, "corner_charge": 28160, "catalog_charge": 0, "total": 309760,
    "cgst_percent": 9, "cgst_amount": 27878.4, "sgst_percent": 9, "sgst_amount": 27878.4,
    "igst_percent": null, "igst": 0, "total_gst_amount": 55756.8, "net_payable_amount": 365516.8,
    "status": "In-Progress", "valid_till": "2026-10-02T11:00:00.000Z",
    "item_added_at": "2026-10-02T10:00:00.000Z", "is_fnb_stall": false, "is_branding_stall": false
  }]
}
```

## Writing it to SelfCare (in one transaction)

1. Lock the stall: `SELECT … FROM idp."T_STALLS" WHERE id = $stall_id` (or `hall_id`, `island_number`,
   `stall_number`) `FOR UPDATE`, and stop unless `booking_status = 'Available'`.
2. Insert `T_STALL_BOOKING` (SelfCare assigns `id` and `booking_code`).
3. Insert each `T_STALL_BOOKING_DETAIL` with `booking_id` = the new id and `stall_id` = the locked stall.
4. Update `T_STALLS.booking_status` to `In-Progress`.

## Open points

- The planner's own stall status becomes `BOOKED` at once, while SelfCare's is `In-Progress` until
  payment; if SelfCare times the booking out, the planner is not told.
- The hold length (60 minutes) is read from the data, not from SelfCare's configuration.
- `stall_id` and `hall_id` are SelfCare's ids; the planner does not store them.
