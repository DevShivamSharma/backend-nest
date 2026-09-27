# Planner test inventory — 27 September 2026

Generated from actual final Jest and Playwright JSON reports. Counts include parameterized test cases once; assertions inside a test are not counted separately. See planner-validation-test-report.md for the rule matrix and reproduced bugs.

## Unit: 355 passed / 355 total

### src/layouts/assist/adversarial-assist.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U001 | adversarial auto-layout proposals ADV-P01 rows / rectangle passes whole-layout final validation | PASSED |
| U002 | adversarial auto-layout proposals ADV-P01 rows / notch passes whole-layout final validation | PASSED |
| U003 | adversarial auto-layout proposals ADV-P01 rows / circle passes whole-layout final validation | PASSED |
| U004 | adversarial auto-layout proposals ADV-P01 back_to_back / rectangle passes whole-layout final validation | PASSED |
| U005 | adversarial auto-layout proposals ADV-P01 back_to_back / notch passes whole-layout final validation | PASSED |
| U006 | adversarial auto-layout proposals ADV-P01 back_to_back / circle passes whole-layout final validation | PASSED |
| U007 | adversarial auto-layout proposals ADV-P01 island / rectangle passes whole-layout final validation | PASSED |
| U008 | adversarial auto-layout proposals ADV-P01 island / notch passes whole-layout final validation | PASSED |
| U009 | adversarial auto-layout proposals ADV-P01 island / circle passes whole-layout final validation | PASSED |
| U010 | adversarial auto-layout proposals ADV-P01 perimeter / rectangle passes whole-layout final validation | PASSED |
| U011 | adversarial auto-layout proposals ADV-P01 perimeter / notch passes whole-layout final validation | PASSED |
| U012 | adversarial auto-layout proposals ADV-P01 perimeter / circle passes whole-layout final validation | PASSED |

### src/layouts/seed-import.controller.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U013 | trusted historical seed import exception ADV-S01 missing/wrong token undefined never calls persistence | PASSED |
| U014 | trusted historical seed import exception ADV-S01 missing/wrong token "" never calls persistence | PASSED |
| U015 | trusted historical seed import exception ADV-S01 missing/wrong token "wrong-token" never calls persistence | PASSED |
| U016 | trusted historical seed import exception ADV-S02 configured token deliberately uses the historical placement bypass | PASSED |

### src/layouts/placement/adversarial-placement.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U017 | adversarial planner geometry ADV-G01 rigid transform 0.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U018 | adversarial planner geometry ADV-G01 rigid transform 10.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U019 | adversarial planner geometry ADV-G01 rigid transform 20.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U020 | adversarial planner geometry ADV-G01 rigid transform 30.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U021 | adversarial planner geometry ADV-G01 rigid transform 40.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U022 | adversarial planner geometry ADV-G01 rigid transform 50.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U023 | adversarial planner geometry ADV-G01 rigid transform 60.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U024 | adversarial planner geometry ADV-G01 rigid transform 70.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U025 | adversarial planner geometry ADV-G01 rigid transform 80.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U026 | adversarial planner geometry ADV-G01 rigid transform 90.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U027 | adversarial planner geometry ADV-G01 rigid transform 100.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U028 | adversarial planner geometry ADV-G01 rigid transform 110.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U029 | adversarial planner geometry ADV-G01 rigid transform 120.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U030 | adversarial planner geometry ADV-G01 rigid transform 130.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U031 | adversarial planner geometry ADV-G01 rigid transform 140.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U032 | adversarial planner geometry ADV-G01 rigid transform 150.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U033 | adversarial planner geometry ADV-G01 rigid transform 160.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U034 | adversarial planner geometry ADV-G01 rigid transform 170.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U035 | adversarial planner geometry ADV-G01 rigid transform 180.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U036 | adversarial planner geometry ADV-G01 rigid transform 190.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U037 | adversarial planner geometry ADV-G01 rigid transform 200.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U038 | adversarial planner geometry ADV-G01 rigid transform 210.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U039 | adversarial planner geometry ADV-G01 rigid transform 220.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U040 | adversarial planner geometry ADV-G01 rigid transform 230.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U041 | adversarial planner geometry ADV-G01 rigid transform 240.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U042 | adversarial planner geometry ADV-G01 rigid transform 250.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U043 | adversarial planner geometry ADV-G01 rigid transform 260.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U044 | adversarial planner geometry ADV-G01 rigid transform 270.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U045 | adversarial planner geometry ADV-G01 rigid transform 280.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U046 | adversarial planner geometry ADV-G01 rigid transform 290.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U047 | adversarial planner geometry ADV-G01 rigid transform 300.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U048 | adversarial planner geometry ADV-G01 rigid transform 310.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U049 | adversarial planner geometry ADV-G01 rigid transform 320.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U050 | adversarial planner geometry ADV-G01 rigid transform 330.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U051 | adversarial planner geometry ADV-G01 rigid transform 340.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U052 | adversarial planner geometry ADV-G01 rigid transform 350.37 degrees preserves exact/short corner gaps and touching backs | PASSED |
| U053 | adversarial planner geometry ADV-G02 FRONT side rejects a 1 mm strip encroachment | PASSED |
| U054 | adversarial planner geometry ADV-G02 BACK side rejects a 1 mm strip encroachment | PASSED |
| U055 | adversarial planner geometry ADV-G02 LEFT side rejects a 1 mm strip encroachment | PASSED |
| U056 | adversarial planner geometry ADV-G02 RIGHT side rejects a 1 mm strip encroachment | PASSED |
| U057 | adversarial planner geometry ADV-G03 point contact is not a shared back; partial edge contact is allowed | PASSED |
| U058 | adversarial planner geometry ADV-G04 cancelled blockers are ignored but booked blockers are enforced | PASSED |
| U059 | adversarial planner geometry ADV-G05 audit reports BOTH facing open sides, with each affected stall | PASSED |
| U060 | adversarial planner geometry ADV-G06 overlap area is translation-invariant at large coordinates | PASSED |
| U061 | adversarial planner geometry ADV-G07 finite coordinates which collapse stall edges are rejected without throwing | PASSED |

### src/halls/selfcare-annotations.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U062 | SelfCare Hall 14FF annotation pipeline uses repaired annotations when seeding demo masters without replacing their geometry | PASSED |
| U063 | SelfCare Hall 14FF annotation pipeline keeps every source image, group, repeated label and visibility flag | PASSED |
| U064 | SelfCare Hall 14FF annotation pipeline survives Nest whitelist, validation, repository write and response serialization | PASSED |
| U065 | SelfCare Hall 14FF annotation pipeline repairs only annotation columns, is repeatable, and defaults to a dry run | PASSED |

### src/layouts/layout.service.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U066 | LayoutService ADV-N01 rejects automatic identifier sequence exhaustion before persistence | PASSED |
| U067 | LayoutService BR-14 layout name uses the trimmed layoutName | PASSED |
| U068 | LayoutService BR-14 layout name falls back to the trimmed hall name when layoutName is null | PASSED |
| U069 | LayoutService BR-14 layout name falls back to the trimmed hall name when layoutName is undefined | PASSED |
| U070 | LayoutService BR-14 layout name falls back to the trimmed hall name when layoutName is "" | PASSED |
| U071 | LayoutService BR-14 layout name falls back to the trimmed hall name when layoutName is "   " | PASSED |
| U072 | LayoutService BR-15 hallHeight is always 0 | PASSED |
| U073 | LayoutService BR-17 stall defaults applies Shop / #3498db / FRONT and trims the name but not the colour | PASSED |
| U074 | LayoutService openSides keeps the full list and syncs gateSide to the first open side | PASSED |
| U075 | LayoutService openSides dedupes entries and derives the list from gateSide when absent or empty | PASSED |
| U076 | LayoutService openSides the response stall carries openSides | PASSED |
| U077 | LayoutService openSides legacy rows without open_sides derive the list from gate_side | PASSED |
| U078 | LayoutService BR-18 client ids never reach the repository | PASSED |
| U079 | LayoutService BR-19 hall copy stores the shape normalised but the hall name UNtrimmed | PASSED |
| U080 | LayoutService BR-19 hall copy a circular layout stores hallWidth = hallLength = 0 | PASSED |
| U081 | LayoutService BR-19 hall copy copyHall keeps blockedAreas, defaulting to null when absent | PASSED |
| U082 | LayoutService BR-19 hall copy the response hall carries blockedAreas | PASSED |
| U083 | LayoutService response envelope (ADR-009) save: message + the hall and stalls both nested and top-level | PASSED |
| U084 | LayoutService response envelope (ADR-009) update: its own message | PASSED |
| U085 | LayoutService response envelope (ADR-009) get: message is null | PASSED |
| U086 | LayoutService not found is a 400-class domain error with the Java text (ADR-003) get | PASSED |
| U087 | LayoutService not found is a 400-class domain error with the Java text (ADR-003) update | PASSED |
| U088 | LayoutService not found is a 400-class domain error with the Java text (ADR-003) delete | PASSED |
| U089 | LayoutService not found is a 400-class domain error with the Java text (ADR-003) update validates the body BEFORE looking the layout up (Java order) | PASSED |
| U090 | LayoutService nothing is written when validation fails | PASSED |
| U091 | LayoutService R-07 rejects more stalls than the configured maximum before validating them | PASSED |
| U092 | LayoutService — rule-driven halls BR-25 stable stall numbers save numbers every stall from STALL-001 and stores the next sequence | PASSED |
| U093 | LayoutService — rule-driven halls BR-25 stable stall numbers update keeps issued numbers and never reuses a removed one | PASSED |
| U094 | LayoutService — rule-driven halls BR-25 stable stall numbers a cancelled stall keeps its number and status | PASSED |
| U095 | LayoutService — rule-driven halls BR-25 stable stall numbers accepts an explicit parent identifier on creation | PASSED |
| U096 | LayoutService — rule-driven halls BR-25 stable stall numbers rejects the same issued number on two stalls | PASSED |
| U097 | LayoutService — rule-driven halls BR-24 placement rules rejects a new stall with a 2 m gap and reports what and where | PASSED |
| U098 | LayoutService — rule-driven halls BR-24 placement rules blocks an unchanged existing stall if it breaks a rule | PASSED |
| U099 | LayoutService — rule-driven halls BR-24 placement rules checks the same stall once it is moved | PASSED |
| U100 | LayoutService — rule-driven halls BR-24 placement rules applies to halls without rules | PASSED |
| U101 | LayoutService — rule-driven halls BR-24 placement rules can be skipped by trusted imports of existing production placements | PASSED |
| U102 | LayoutService — rule-driven halls BR-24 placement rules BR-13 ignores cancelled stalls: a new stall may take a cancelled stall's space | PASSED |
| U103 | LayoutService — rule-driven halls audit reports existing problems without blocking | PASSED |
| U104 | LayoutService — rule-driven halls audit audits even a hall without explicit rules | PASSED |
| U105 | LayoutService — rule-driven halls BR-22 / BR-23 input checks rejects a boundary with fewer than 3 points | PASSED |
| U106 | LayoutService — rule-driven halls BR-22 / BR-23 input checks rejects an unknown zone kind | PASSED |
| U107 | LayoutService — rule-driven halls BR-22 / BR-23 input checks rejects an unknown stall status | PASSED |
| U108 | LayoutService — rule-driven halls BR-22 / BR-23 input checks rejects an unknown event type | PASSED |

### src/layouts/assist/assist.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U109 | assistant intent and fallback parses cut 20 stalls of 3x3 along the left wall, 4 m aisles | PASSED |
| U110 | assistant intent and fallback parses 12 stalls of 3x3 near FOYER-1G | PASSED |
| U111 | assistant intent and fallback parses fill the foyer with 3x2 stalls | PASSED |
| U112 | assistant intent and fallback extracts count, wall, dimensions and aisle | PASSED |
| U113 | assistant intent and fallback asks for clarification when ambiguous | PASSED |
| U114 | assistant intent and fallback clear is an intent, never a mutation | PASSED |
| U115 | assistant intent and fallback rejects invalid intent 0 | PASSED |
| U116 | assistant intent and fallback rejects invalid intent 1 | PASSED |
| U117 | assistant intent and fallback rejects invalid intent 2 | PASSED |
| U118 | assistant intent and fallback rejects invalid intent 3 | PASSED |
| U119 | assistant intent and fallback rejects invalid intent 4 | PASSED |
| U120 | assistant intent and fallback rejects invalid intent 5 | PASSED |
| U121 | assistant intent and fallback rejects invalid intent 6 | PASSED |
| U122 | assistant intent and fallback rejects invalid intent 7 | PASSED |
| U123 | assistant intent and fallback rejects invalid intent 8 | PASSED |
| U124 | assistant intent and fallback bounds input length | PASSED |
| U125 | assistant intent and fallback rejects malformed hall and stall geometry | PASSED |
| U126 | deterministic proposal planner honours count in rows along a wall | PASSED |
| U127 | deterministic proposal planner places near a marker | PASSED |
| U128 | deterministic proposal planner asks instead of guessing an unknown marker | PASSED |
| U129 | deterministic proposal planner never overlaps walls, restricted zones, passages or existing rotated stalls | PASSED |
| U130 | deterministic proposal planner places in a separate foyer region within the authoritative boundary | PASSED |
| U131 | deterministic proposal planner never expands an explicit boundary to include a drawn foyer | PASSED |
| U132 | deterministic proposal planner resolves a foyer label between floor islands to the separate foyer | PASSED |
| U133 | deterministic proposal planner supports circle halls without leaving the floor | PASSED |
| U134 | deterministic proposal planner keeps minimum aisle width | PASSED |
| U135 | deterministic proposal planner keeps odd-sized halls on the existing edge snap grid | PASSED |
| U136 | deterministic proposal planner reports no space rather than breaking placement rules | PASSED |
| U137 | deterministic proposal planner proposes removals without modifying existing stalls | PASSED |
| U138 | provider isolation does not call a provider without configuration | PASSED |
| U139 | provider isolation retries invalid JSON once | PASSED |
| U140 | provider isolation falls back after two invalid replies | PASSED |
| U141 | provider isolation times out the whole provider operation at 15 seconds | PASSED |
| U142 | provider isolation sends only intent requests to gemini | PASSED |
| U143 | provider isolation sends only intent requests to groq | PASSED |
| U144 | provider isolation sends only intent requests to grok | PASSED |
| U145 | provider isolation does not expose provider errors or keys | PASSED |

### src/common/health/health.controller.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U146 | HealthController liveness reports ok with an uptime and never touches the database | PASSED |
| U147 | HealthController readiness reports the database up when it answers | PASSED |
| U148 | HealthController readiness is 503 when the database does not answer | PASSED |

### src/halls/hall.service.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U149 | HallService amenities stores amenities given to create | PASSED |
| U150 | HallService amenities stores amenities given to update — the path the seeder uses | PASSED |
| U151 | HallService amenities returns stored amenities on read | PASSED |
| U152 | HallService amenities defaults a missing label to the kind, and keeps amenities outside the hall | PASSED |
| U153 | HallService amenities rejects an amenity with no kind or a non-numeric position | PASSED |
| U154 | HallService amenities keeps an amenity's card anchor and slot, so the icon row survives a save | PASSED |
| U155 | HallService amenities persists the plan's compass and legend, and keeps a hidden zone hidden | PASSED |
| U156 | HallService amenities rejects a malformed compass or legend | PASSED |
| U157 | HallService amenities leaves amenities null when the request omits them | PASSED |
| U158 | HallService read lists every hall | PASSED |
| U159 | HallService read list returns blockedAreas when the hall has them | PASSED |
| U160 | HallService read returns one hall by id | PASSED |
| U161 | HallService read raises the Java not-found message when the hall is missing | PASSED |
| U162 | HallService create persists the five writable columns | PASSED |
| U163 | HallService create passes blockedAreas through on create | PASSED |
| U164 | HallService create drops any id sent by the client (BR-18, HallController.java:58) | PASSED |
| U165 | HallService create normalizes the shape | PASSED |
| U166 | HallService validation (ADR-015) rejects a missing body | PASSED |
| U167 | HallService validation (ADR-015) rejects a nonsense shape | PASSED |
| U168 | HallService validation (ADR-015) checks shape before name, as on the layout path | PASSED |
| U169 | HallService validation (ADR-015) rejects a blank name | PASSED |
| U170 | HallService validation (ADR-015) rejects a non-positive width or length on a SQUARE hall | PASSED |
| U171 | HallService validation (ADR-015) rejects a non-positive radius on a CIRCLE hall | PASSED |
| U172 | HallService validation (ADR-015) does not check width or length on a CIRCLE hall | PASSED |
| U173 | HallService validation (ADR-015) applies the same rules on update | PASSED |
| U174 | HallService update overwrites all five fields | PASSED |
| U175 | HallService update passes blockedAreas through on update | PASSED |
| U176 | HallService update raises not found when the hall is missing | PASSED |
| U177 | HallService delete deletes an existing hall | PASSED |
| U178 | HallService delete raises not found when the hall is missing | PASSED |

### src/database/data-source-options.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U179 | buildDataSourceOptions registers every migration file in the migrations directory | PASSED |

### src/common/filters/all-exceptions.filter.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U180 | AllExceptionsFilter always uses the Java body shape: success, status, message | PASSED |
| U181 | AllExceptionsFilter branch 1 — IllegalArgumentException equivalent maps to 400 with the message passed through verbatim | PASSED |
| U182 | AllExceptionsFilter branch 1 — IllegalArgumentException equivalent keeps "not found" on 400, matching the Java (ADR-003) | PASSED |
| U183 | AllExceptionsFilter branch 2 — DataIntegrityViolationException equivalent maps to 409 with the fixed Java message | PASSED |
| U184 | AllExceptionsFilter branch 3 — raw PostgreSQL integrity violation maps SQLSTATE 23503 (foreign key violation) to 409 | PASSED |
| U185 | AllExceptionsFilter branch 3 — raw PostgreSQL integrity violation maps SQLSTATE 23505 (unique violation) to 409 | PASSED |
| U186 | AllExceptionsFilter branch 3 — raw PostgreSQL integrity violation maps SQLSTATE 23502 (not-null violation) to 409 | PASSED |
| U187 | AllExceptionsFilter branch 3 — raw PostgreSQL integrity violation also reads the code from a TypeORM driverError wrapper | PASSED |
| U188 | AllExceptionsFilter branch 3 — raw PostgreSQL integrity violation does not treat an unrelated SQLSTATE class as an integrity violation | PASSED |
| U189 | AllExceptionsFilter branch 4 — HttpException maps a ValidationPipe failure to 400 with the first violation only | PASSED |
| U190 | AllExceptionsFilter branch 4 — HttpException handles a string response payload | PASSED |
| U191 | AllExceptionsFilter branch 4 — HttpException lets an unknown route stay 404 | PASSED |
| U192 | AllExceptionsFilter branch 5 — unknown errors returns 500 with the fixed Java fallback message | PASSED |
| U193 | AllExceptionsFilter branch 5 — unknown errors does NOT leak the root cause, unlike the Java (S-05) | PASSED |
| U194 | AllExceptionsFilter branch 5 — unknown errors handles a non-Error throwable | PASSED |

### src/config/env.validation.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U195 | validateEnv accepts a complete environment and coerces numeric strings | PASSED |
| U196 | validateEnv applies defaults for every optional variable | PASSED |
| U197 | validateEnv fails loudly and names the missing variable: DATABASE_HOST | PASSED |
| U198 | validateEnv fails loudly and names the missing variable: DATABASE_NAME | PASSED |
| U199 | validateEnv fails loudly and names the missing variable: DATABASE_USER | PASSED |
| U200 | validateEnv fails loudly and names the missing variable: DATABASE_PASSWORD | PASSED |
| U201 | validateEnv rejects an out-of-range port | PASSED |
| U202 | validateEnv rejects an unknown NODE_ENV | PASSED |
| U203 | validateEnv never includes a variable value in the error message | PASSED |

### src/layouts/placement/authoritative-placement.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U204 | authoritative rotated passage validation corner: rejects short gap and accepts exactly 3 metres | PASSED |
| U205 | authoritative rotated passage validation corner: rejects short gap and accepts exactly 5 metres | PASSED |
| U206 | authoritative rotated passage validation rejects invalid width 2.99 | PASSED |
| U207 | authoritative rotated passage validation rejects invalid width 5.01 | PASSED |
| U208 | authoritative rotated passage validation rejects invalid width -1 | PASSED |
| U209 | authoritative rotated passage validation rejects invalid width 0 | PASSED |
| U210 | authoritative rotated passage validation rejects invalid width NaN | PASSED |
| U211 | authoritative rotated passage validation rejects invalid width Infinity | PASSED |
| U212 | authoritative rotated passage validation rejects invalid width "3" | PASSED |
| U213 | authoritative rotated passage validation rejects invalid width null | PASSED |
| U214 | authoritative rotated passage validation defaults both event types to 3 and persists explicit fractional widths | PASSED |
| U215 | authoritative rotated passage validation accepts touching backs with opposite outward open sides | PASSED |
| U216 | authoritative rotated passage validation rejects touching with open sides ["FRONT"] | PASSED |
| U217 | authoritative rotated passage validation rejects touching with open sides ["LEFT"] | PASSED |
| U218 | authoritative rotated passage validation rejects touching with open sides ["BACK", "RIGHT"] | PASSED |
| U219 | authoritative rotated passage validation does not exempt corner stalls from passage for back-to-back touching | PASSED |
| U220 | authoritative rotated passage validation open side must have exactly 3 metres inside the hall | PASSED |
| U221 | authoritative rotated passage validation open side must have exactly 5 metres inside the hall | PASSED |
| U222 | authoritative rotated passage validation another stall cannot enter any open-side strip | PASSED |
| U223 | authoritative rotated passage validation rotates edges AND sides by 30 degrees, preserving valid backs and edge gaps | PASSED |
| U224 | authoritative rotated passage validation rotates edges AND sides by 45 degrees, preserving valid backs and edge gaps | PASSED |
| U225 | authoritative rotated passage validation rotates edges AND sides by 90 degrees, preserving valid backs and edge gaps | PASSED |
| U226 | authoritative rotated passage validation rotates edges AND sides by 135 degrees, preserving valid backs and edge gaps | PASSED |
| U227 | authoritative rotated passage validation rotates edges AND sides by 270 degrees, preserving valid backs and edge gaps | PASSED |
| U228 | authoritative rotated passage validation detects a rotated footprint outside the hall even if unrotated extents fit | PASSED |
| U229 | authoritative rotated passage validation outside space in a concave notch is never passage | PASSED |
| U230 | authoritative rotated passage validation uses a notch corner, not the hall bounding box, for corner spacing | PASSED |
| U231 | authoritative rotated passage validation does not count the gap across an exterior notch as corner passage | PASSED |
| U232 | authoritative rotated passage validation rejects an exterior sliver inside the full corner gap even when its shortest connector is clear | PASSED |
| U233 | authoritative rotated passage validation detects an edge crossing a narrow concavity even when all vertices are inside | PASSED |
| U234 | authoritative rotated passage validation subtracts blocked-area holes from usable floor and passage | PASSED |
| U235 | authoritative rotated passage validation uses true circular boundary for open-side passage | PASSED |
| U236 | authoritative rotated passage validation rejects malformed boundaries rather than treating them as usable floor | PASSED |
| U237 | authoritative rotated passage validation checks split containment against rotated parent geometry | PASSED |
| U238 | split identifiers issues A through Z, then AA, AB, AZ, BA, ZZ, AAA | PASSED |

### src/layouts/placement/placement-rules.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U239 | placement-rules hall boundary accepts a stall well inside the irregular hall | PASSED |
| U240 | placement-rules hall boundary rejects a stall that reaches into the cut-out notch | PASSED |
| U241 | placement-rules hall boundary rejects a stall entirely inside the notch | PASSED |
| U242 | placement-rules hall boundary treats touching the boundary as inside (the clearance rule is separate) | PASSED |
| U243 | placement-rules peripheral clearance (ITPO D5) rejects a stall 0.5 m from the wall and reports what is left | PASSED |
| U244 | placement-rules peripheral clearance (ITPO D5) accepts exactly 1 m | PASSED |
| U245 | placement-rules peripheral clearance (ITPO D5) measures from the notch walls too | PASSED |
| U246 | placement-rules peripheral clearance (ITPO D5) uses the configured value, not a grid cell | PASSED |
| U247 | placement-rules stall overlap rejects a large stall over three small ones and names them | PASSED |
| U248 | placement-rules stall overlap rejects side-by-side touching with parallel open directions | PASSED |
| U249 | placement-rules stall overlap ignores the stall being moved | PASSED |
| U250 | placement-rules stall overlap ignores cancelled stalls: they no longer occupy space | PASSED |
| U251 | placement-rules passage width (ITPO D1) rejects a 2 m gap for B2B (3 m required) and draws the gap | PASSED |
| U252 | placement-rules passage width (ITPO D1) accepts a 3 m gap for B2B | PASSED |
| U253 | placement-rules passage width (ITPO D1) accepts the default 3 m gap for B2C | PASSED |
| U254 | placement-rules passage width (ITPO D1) measures diagonal gaps as a straight-line distance | PASSED |
| U255 | placement-rules restricted zones rejects overlapping a compulsory passage | PASSED |
| U256 | placement-rules restricted zones allows touching a zone with no clearance | PASSED |
| U257 | placement-rules restricted zones applies the configured clearance around a smoke curtain (ITPO D7) | PASSED |
| U258 | placement-rules openings (ITPO D2, D3) rejects a stall in front of an emergency exit | PASSED |
| U259 | placement-rules openings (ITPO D2, D3) sizes the access zone from the event passage width | PASSED |
| U260 | placement-rules dimensions rejects sizes that are not multiples of the snap step | PASSED |
| U261 | placement-rules dimensions rejects non-positive sizes | PASSED |
| U262 | placement-rules auditLayout reports a pair problem once, on the first stall of the pair | PASSED |
| U263 | placement-rules auditLayout is empty for a valid layout | PASSED |
| U264 | placement-rules formats stall numbers with a zero-padded sequence | PASSED |
| U265 | placement-rules traceFloor keeps every disconnected floor region, largest first | PASSED |
| U266 | placement-rules traceFloor does not clip a walled region at the canvas breadth | PASSED |
| U267 | placement-rules traceFloor never turns the unmasked margin of the grown canvas into floor | PASSED |
| U268 | placement-rules traceFloor returns nothing for a plan without outside or wall rectangles | PASSED |
| U269 | placement-rules traceFloor does not extend an explicit boundary with inferred outside regions | PASSED |

### src/layouts/layout.validator.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U270 | validateLayoutRequest accepts a valid rectangular layout | PASSED |
| U271 | validateLayoutRequest accepts a valid circular layout | PASSED |
| U272 | validateLayoutRequest BR-01 request body required | PASSED |
| U273 | validateLayoutRequest BR-02 hall required | PASSED |
| U274 | validateLayoutRequest BR-03 hall shape rejects "TRIANGLE" | PASSED |
| U275 | validateLayoutRequest BR-03 hall shape rejects "" | PASSED |
| U276 | validateLayoutRequest BR-03 hall shape rejects null | PASSED |
| U277 | validateLayoutRequest BR-03 hall shape rejects undefined | PASSED |
| U278 | validateLayoutRequest BR-03 hall shape rejects "   " | PASSED |
| U279 | validateLayoutRequest BR-03 hall shape normalises case and whitespace | PASSED |
| U280 | validateLayoutRequest BR-03 hall shape ORDER: a bad shape is reported BEFORE a blank name (Java :427 precedes :434) | PASSED |
| U281 | validateLayoutRequest BR-04 hall name required: null | PASSED |
| U282 | validateLayoutRequest BR-04 hall name required: undefined | PASSED |
| U283 | validateLayoutRequest BR-04 hall name required: "" | PASSED |
| U284 | validateLayoutRequest BR-04 hall name required: "   " | PASSED |
| U285 | validateLayoutRequest BR-05 rectangular hall dimensions rejects width=0 length=40 | PASSED |
| U286 | validateLayoutRequest BR-05 rectangular hall dimensions rejects width=40 length=0 | PASSED |
| U287 | validateLayoutRequest BR-05 rectangular hall dimensions rejects width=-1 length=40 | PASSED |
| U288 | validateLayoutRequest BR-05 rectangular hall dimensions rejects width=null length=40 | PASSED |
| U289 | validateLayoutRequest BR-05 rectangular hall dimensions rejects width=40 length=undefined | PASSED |
| U290 | validateLayoutRequest BR-05 rectangular hall dimensions does not look at the radius of a rectangular hall | PASSED |
| U291 | validateLayoutRequest BR-06 circular hall radius rejects radius=0 | PASSED |
| U292 | validateLayoutRequest BR-06 circular hall radius rejects radius=-3 | PASSED |
| U293 | validateLayoutRequest BR-06 circular hall radius rejects radius=null | PASSED |
| U294 | validateLayoutRequest BR-06 circular hall radius rejects radius=undefined | PASSED |
| U295 | validateLayoutRequest BR-06 circular hall radius does not look at width/length of a circular hall | PASSED |
| U296 | validateLayoutRequest BR-07 zero stalls is valid — null, missing or empty | PASSED |
| U297 | validateLayoutRequest BR-08 null stall element | PASSED |
| U298 | validateLayoutRequest BR-09 non-finite width | PASSED |
| U299 | validateLayoutRequest BR-09 non-finite length | PASSED |
| U300 | validateLayoutRequest BR-09 non-finite height | PASSED |
| U301 | validateLayoutRequest BR-09 non-finite posX | PASSED |
| U302 | validateLayoutRequest BR-09 non-finite posZ | PASSED |
| U303 | validateLayoutRequest BR-10 stall dimensions rejects zero / negative / null width | PASSED |
| U304 | validateLayoutRequest BR-10 stall dimensions rejects zero / negative / null length | PASSED |
| U305 | validateLayoutRequest BR-10 stall dimensions rejects zero / negative / null height | PASSED |
| U306 | validateLayoutRequest leaves geometry checks to shared rotated placement validation | PASSED |
| U307 | validateLayoutRequest BR-12 gate side rejects an unknown value | PASSED |
| U308 | validateLayoutRequest BR-12 gate side accepts null | PASSED |
| U309 | validateLayoutRequest BR-12 gate side accepts undefined | PASSED |
| U310 | validateLayoutRequest BR-12 gate side accepts "" | PASSED |
| U311 | validateLayoutRequest BR-12 gate side accepts "  " | PASSED |
| U312 | validateLayoutRequest BR-12 gate side accepts "left" | PASSED |
| U313 | validateLayoutRequest BR-12 gate side accepts " Back " | PASSED |
| U314 | validateLayoutRequest rule order inside the stall loop dimensions (BR-10) before boundary (BR-11) | PASSED |
| U315 | validateLayoutRequest rule order inside the stall loop validates open-side input before the geometry stage | PASSED |
| U316 | validateLayoutRequest rule order inside the stall loop gate (BR-12) before overlap (BR-13) | PASSED |
| U317 | validateLayoutRequest rule order inside the stall loop an earlier stall problem wins over a later one | PASSED |
| U318 | validateLayoutRequest rule order inside the stall loop gate (BR-12) before openSides entries | PASSED |
| U319 | validateLayoutRequest openSides entries rejects an invalid entry | PASSED |
| U320 | validateLayoutRequest openSides entries rejects non-string entries | PASSED |
| U321 | validateLayoutRequest openSides entries accepts any valid combination of 1-4 sides | PASSED |
| U322 | validateLayoutRequest openSides entries accepts an absent, null or empty list (falls back to gateSide) | PASSED |
| U323 | normalizeShape / normalizeGate return the normalised value | PASSED |

### src/layouts/java-double.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U324 | formatJavaDouble — matches Java Double.toString 0 -> 0.0 | PASSED |
| U325 | formatJavaDouble — matches Java Double.toString -0 -> -0.0 | PASSED |
| U326 | formatJavaDouble — matches Java Double.toString 16 -> 16.0 | PASSED |
| U327 | formatJavaDouble — matches Java Double.toString -8 -> -8.0 | PASSED |
| U328 | formatJavaDouble — matches Java Double.toString 1.5 -> 1.5 | PASSED |
| U329 | formatJavaDouble — matches Java Double.toString -17.25 -> -17.25 | PASSED |
| U330 | formatJavaDouble — matches Java Double.toString 0.001 -> 0.001 | PASSED |
| U331 | formatJavaDouble — matches Java Double.toString 9999999 -> 9999999.0 | PASSED |
| U332 | formatJavaDouble — matches Java Double.toString 10000000 -> 1.0E7 | PASSED |
| U333 | formatJavaDouble — matches Java Double.toString 12345678.5 -> 1.23456785E7 | PASSED |
| U334 | formatJavaDouble — matches Java Double.toString 0.0001 -> 1.0E-4 | PASSED |
| U335 | formatJavaDouble — matches Java Double.toString -0.000025 -> -2.5E-5 | PASSED |
| U336 | formatJavaDouble — matches Java Double.toString NaN -> NaN | PASSED |
| U337 | formatJavaDouble — matches Java Double.toString Infinity -> Infinity | PASSED |
| U338 | formatJavaDouble — matches Java Double.toString -Infinity -> -Infinity | PASSED |

### src/layouts/layout.geometry.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| U339 | isInsideHall — rectangular (BR-11) accepts a stall at the centre | PASSED |
| U340 | isInsideHall — rectangular (BR-11) accepts a stall exactly flush against the wall | PASSED |
| U341 | isInsideHall — rectangular (BR-11) rejects a stall that crosses the wall by a hair | PASSED |
| U342 | isInsideHall — rectangular (BR-11) checks width against X and length against Z independently | PASSED |
| U343 | isInsideHall — rectangular (BR-11) tolerates floating point noise within 1e-8 | PASSED |
| U344 | isInsideHall — circular (BR-11, conservative half-diagonal rule) accepts a stall at the centre | PASSED |
| U345 | isInsideHall — circular (BR-11, conservative half-diagonal rule) accepts a stall whose half-diagonal circle just touches the rim | PASSED |
| U346 | isInsideHall — circular (BR-11, conservative half-diagonal rule) rejects just beyond that | PASSED |
| U347 | isInsideHall — circular (BR-11, conservative half-diagonal rule) is deliberately stricter than a four-corner check | PASSED |
| U348 | isInsideHall — circular (BR-11, conservative half-diagonal rule) ignores hall width/length for a circle | PASSED |
| U349 | stallsOverlap (BR-13) detects two stalls on the same spot | PASSED |
| U350 | stallsOverlap (BR-13) detects a partial overlap | PASSED |
| U351 | stallsOverlap (BR-13) allows stalls that share an edge — shops may stand wall to wall | PASSED |
| U352 | stallsOverlap (BR-13) allows stalls that touch only at a corner | PASSED |
| U353 | stallsOverlap (BR-13) requires overlap on BOTH axes | PASSED |
| U354 | stallsOverlap (BR-13) uses each stall own dimensions | PASSED |
| U355 | stallsOverlap (BR-13) is symmetric | PASSED |

## Integration: 30 passed / 30 total

### test/assist.e2e-spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| I001 | Layout assistant HTTP matches the existing frontend contract with no key | PASSED |
| I002 | Layout assistant HTTP rejects oversized requirements | PASSED |
| I003 | Layout assistant HTTP rate limits only the assistant endpoint | PASSED |

### test/layouts.e2e-spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| I004 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save 201, the Java envelope, and rows in all three tables | PASSED |
| I005 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save ids are JSON numbers, start at 1000, and the client hall id is ignored (G-5, BR-18) | PASSED |
| I006 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save saving the same hall twice creates two hall rows (BR-19) | PASSED |
| I007 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save a rejected request writes NOTHING | PASSED |
| I008 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save out of bounds -> 400 with structured geometry | PASSED |
| I009 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save missing hall -> the Java message, not a generic pipe message | PASSED |
| I010 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save wrong type -> 400 (ADR-014; the Java answered 500) | PASSED |
| I011 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save malformed JSON -> 400 in the standard envelope | PASSED |
| I012 | Layouts API (e2e, real PostgreSQL) POST /api/layout/save saves a circular layout with hallWidth 0 | PASSED |
| I013 | Layouts API (e2e, real PostgreSQL) GET /api/layout/:id returns what was saved, message null, stalls in insertion order | PASSED |
| I014 | Layouts API (e2e, real PostgreSQL) GET /api/layout/:id unknown id -> 400 "Layout not found" (ADR-003) | PASSED |
| I015 | Layouts API (e2e, real PostgreSQL) GET /api/layout/:id non-numeric id -> 400 | PASSED |
| I016 | Layouts API (e2e, real PostgreSQL) PUT /api/layout/:id keeps layout and hall ids, replaces every stall with new ids (BR-16) | PASSED |
| I017 | Layouts API (e2e, real PostgreSQL) PUT /api/layout/:id an invalid update leaves the stored layout untouched | PASSED |
| I018 | Layouts API (e2e, real PostgreSQL) PUT /api/layout/:id unknown id -> 400 | PASSED |
| I019 | Layouts API (e2e, real PostgreSQL) DELETE /api/layout/:id 200 with {message,id}; hall and stalls rows are gone too (BR-20) | PASSED |
| I020 | Layouts API (e2e, real PostgreSQL) DELETE /api/layout/:id unknown id -> 400 | PASSED |
| I021 | Layouts API (e2e, real PostgreSQL) GET /api/layouts empty database -> [] | PASSED |
| I022 | Layouts API (e2e, real PostgreSQL) GET /api/layouts newest first, exact LayoutSummary shape, numeric stallCount (BR-21) | PASSED |
| I023 | Layouts API (e2e, real PostgreSQL) GET /api/layouts /api/layout/list (deprecated duplicate) returns the same thing | PASSED |
| I024 | Layouts API (e2e, real PostgreSQL) cross-cutting readiness reports the database up | PASSED |
| I025 | Layouts API (e2e, real PostgreSQL) cross-cutting CORS: allowed origin echoed, others not | PASSED |

### test/layout-rules.e2e-spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| I026 | Layout rules API (e2e, real PostgreSQL) GET /api/stall-types serves the configured sizes | PASSED |
| I027 | Layout rules API (e2e, real PostgreSQL) rejects a placement with 400, a readable message and structured violations | PASSED |
| I028 | Layout rules API (e2e, real PostgreSQL) keeps stall numbers across PUT, never reuses one, and persists cancellation | PASSED |
| I029 | Layout rules API (e2e, real PostgreSQL) POST /api/layout/{id}/validate reports existing problems without blocking | PASSED |

### test/placement-migration.e2e-spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| I030 | placement migration with existing rows (real PostgreSQL) preserves identifiers/open sides, defaults old rotation, enforces lineage, and supports down/up | PASSED |

## Playwright API: 19 passed / 19 total

### adversarial.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| A001 | ADV-A01 hall resize and layout dimension metadata remain consistent after reload | PASSED |
| A002 | ADV-A02 automatic numbering overflow returns 400 and writes no layout | PASSED |
| A003 | ADV-A03 unrepresentable finite geometry returns structured 400, not an internal error | PASSED |
| A004 | ADV-A04 B2B-to-B2C change revalidates selected width and rolls back | PASSED |
| A005 | ADV-A05 idempotency ignores object key order but detects reordered children | PASSED |
| A006 | ADV-A06 nested split lineage survives forged PUT fields and cannot resurrect parents | PASSED |
| A007 | ADV-A07 overlong generated child identifiers reject the entire split | PASSED |
| A008 | ADV-A08 unauthorized seed import cannot bypass placement validation | PASSED |
| A009 | ADV-A09 rotated corners at previously crashing angles save and reload exactly | PASSED |

### placement.spec.ts

| ID | Test case | Actual result |
| --- | --- | --- |
| A010 | default, 3 m / 5 m corner passage and exact width; invalid inputs write no records | PASSED |
| A011 | rotated back-to-back survives reload; invalid open-side update rolls back | PASSED |
| A012 | irregular outside notch cannot be used as passage and rotated footprint cannot cross it | PASSED |
| A013 | hall update cannot bypass final validation of existing stalls | PASSED |
| A014 | move, rotation, resize and width changes all revalidate the complete PUT state | PASSED |
| A015 | duplicate identifiers and split child collisions are rejected without partial records | PASSED |
| A016 | concurrent split retries create one set; lineage, width, geometry and numbers survive PUT/GET | PASSED |
| A017 | simultaneous different-key splits have exactly one winner | PASSED |
| A018 | invalid split geometry and a late database failure both leave parent and ledger unchanged | PASSED |
| A019 | backend issues A..Z, AA, AB without parsing 5-10 as dimensions | PASSED |

