# Hall 12A demo · 10-minute Hinglish script

Prepared 3 October 2026. Scope: MASTER-PLAN WP1–WP7, through Publish. Pricing, EMC markup and booking polish are Phase 2.

## Open these tabs

- Editable start: http://localhost:4200/planner/editor?layoutId=1093
- Published backup: http://localhost:4200/planner/view?layoutId=1094
- Backend: http://localhost:8080/api/halls

The current IDs are also in `scripts/data/meeting-demo-result.json`. Fresh demo creation changes IDs; use that result if the database has been reseeded. The fixture is a copy of the existing Hall12--A import (source hall 1143): 111 × 117.4 m bounds, an irregular 24-point floor, four imported openings. The demo's four planning zones are illustrative, not venue-approved allocations. Source hall geometry is preserved.

## 0:00–2:00 · Bare hall and zones

“Pehle imported hall ka actual floor, entrances aur exits aate hain. Ab hum floor ko use ke hisaab se divide karte hain.”

Open the editable start, dismiss the plotting rules, and skip the introductory tour if shown. It has no stalls and four zones: Exhibition/B2B, Food/B2C, Media and Admin. Open **Zones**. Explain that Media/Admin reserve internal area; Food/Exhibition accept stalls. Select a zone to show its name, type, event and coordinates. **Draw zone** or **Redraw zone** lets the user drag a rectangle; dimensions can be edited in the coordinate form. Avoid saving experimental edits over the prepared start. Use **New zone** to leave edit mode.

## 2:00–3:30 · Rules before cutting

“AI pehle rules confirm karwata hai. Aisle default 3 metre hai; 1.5 se 5 metre tak allowed. Emergency access minimum 3 metre rahega. B2B/B2C stalls ke beech bhi 3 metre.”

Open **Assist**. Point out the seven standard rules. **Modify** exposes values and corner protection; invalid values show an inline error. Keep the prepared defaults and click **Agree**. Changing hall, zones or rules requires fresh agreement.

## 3:30–5:00 · Guided cutting

Choose **6 × 6 m**, **All sellable zones**, count **fill**, then **Create proposal**. Wait for the proposal and click **Apply**.

“Bada sellable zone pehle fill hota hai. Internal areas aur passages clear rehte hain. 70 percent maximum hai, filling target nahi.”

The prepared deterministic run contains **75 stalls: 54 Exhibition + 21 Food**, 2,700 m² of the 8,480 m² floor (**31.8%**). The remaining floor includes unallocated/internal space and access. Bounded search may return fewer stalls on slower machines; exact packing count is not a correctness guarantee. The meter must stay at or below 70%, with zero placement issues for this prepared geometry.

## 5:00–7:00 · Manual touch-up

Open **Stalls**. Click a stall, then **Select row** to select the aligned row. Use the batch **Open side** selector and **Set open side**. Shift/Ctrl-click (or checkboxes) adds/removes stalls from the selection. **Auto opposite** faces adjacent stalls away from a shared wall; incompatible openings reject atomically with a useful issue.

Select **three adjacent, available 6 × 6 stalls** in one gap-free row and click **Merge to pavilion**. Four also work. Nonrectangular groups, gaps and booked stalls are refused. Existing numbered parent stalls remain cancelled with their identifiers; the pavilion receives a fresh number on save/publish. To show **Split stall**, first save the layout, select the pavilion and preview the split; confirm only a valid preview. This optional touch-up segment can be skipped if time is short; the primary demo proceeds directly from cutting to publishing.

## 7:00–9:00 · Review, publish and view

Use **Layouts → Save New** to create a separate demo run. Open **Review & publish**. Explain utilization, rule issues with **Locate**, and independent suggestions for unused space (each must be checked after any other insertion).

“Publish se pehle issues dikhte hain. Issue ho to reason likhe bina override nahi hoga. Reason aur issues record mein rahenge.”

For the prepared valid plan click **Publish layout**. Confirm **Published**, assigned stall numbers and the **Exhibitor view** link. Any later edit turns the local state back to Draft; a normal save persists Draft and clears the old publication record. The original prepared start and backup stay available.

## 9:00–10:00 · Close

“Bare hall se zones, rules, cutting, manual adjustment aur publish tak flow ready hai. Pricing aur EMC policies next phase mein aayenge.”

If the provider is rate-limited, the simple English size/count request has a deterministic backend parser fallback. If the live browser flow fails, switch to the published backup tab; do not claim the interrupted run was published.

## Recreate and verify

From `backend-nest`, with the local PostgreSQL-backed API running:

```powershell
node -r ts-node/register scripts/prepare-meeting-demo.ts --dry-run
node -r ts-node/register scripts/prepare-meeting-demo.ts
```

The first command computes and audits without writes. The second creates separate start/backup copies and records IDs. `--refresh` updates only the stored, name-checked meeting backup, retaining existing numbers by position. It does not edit the source imported hall.

From `frontend-angular`:

```powershell
$env:PW_PORT='4200'
npm run test:e2e -- e2e/meeting-demo.spec.ts
```

The rehearsal loads the prepared start, agrees to rules, fills through the real backend, checks placement, saves a temporary copy, publishes, verifies numbering and opens the exhibitor view. Its temporary layout is removed afterward.
