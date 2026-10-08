# Venue CSV import and shared JSON adaptation

The venue menu uses **Import from CSV**. The tour opens automatically when this import screen opens, and can be replayed from its help button. A UTF-8 CSV needs a header and one record per hall; quoted commas, doubled quotes, multiline cells, BOM and `NULL` cells are supported. Geometry, foyer, legend and annotation cells may contain JSON arrays/objects, which are decoded before schema adaptation. The internal canonical floor remains `floor/1` JSON; users upload CSV and can download the converted JSON for inspection.

The supplied `T_HALL_LAYOUTS.csv` is retained as a 29-hall regression fixture. The recognised layout-export schema uses `hall_id`, metric `length`/`breadth`, `layout_data`, `legends`, `helper_text`, `exit_labels`, `direction` and `default_stalls`. Dimensions, restrictions, hidden fire curtains, exits, icons, direction and plain legend codes are retained. Template stalls remain a warning; this operation imports floors. Source IDs without names initially display as `Hall <hall_id>`, and the reviewer can rename them. A legacy export with no explicit foyer geometry retains its complete source floor and foyer labels; it does not invent a foyer polygon from a caption.

Other venues can supply metric rectangle/polygon fields or native floor objects inside cells and use column/path mappings for different names. Missing units require a user choice. Malformed JSON cells report the affected hall and prevent that row from saving while valid halls remain available. Invalid CSV column counts, empty/duplicate headers, empty files and more than 500 records are rejected. Preview and save remain separate, each selected hall needs a Three.js inspection, and Select all available / Clear selection make individual and batch saves accessible.

For a batch, the review shows how many selected halls are checked and how many remain. Confirm the active hall, then use **Review next hall** to inspect the next pending selection. Save enables when every selected hall has been checked. The HTTP regression suite saves all 29 sample halls in a single batch and reads each complete floor back from the database for comparison with its converted preview.

Generic wrappers such as `halls`, `rooms`, `floors`, `data` and `payload` are recognised. Unrecognised field names can be mapped with dot paths for the hall collection, name, dimensions, boundary, areas and foyers. Custom area paths support position, dimensions, geometry, meaning and label. Colours without a source meaning require a reviewed area-kind mapping. Source units must be supplied by the file or selected in the UI; pixel coordinates need metres per source unit. Upward Cartesian Y coordinates can be converted explicitly.

All geometry is converted to metres and local top-left coordinates. Polygon holes, foyers, off-grid restrictions, labels and supplied icon/north metadata are retained. The optional `geometry/1` member remains authoritative when reimporting exported floor-plan configs. Unsupported canvas paths, circles or transforms need a supported polygon export; the adapter reports the hall error rather than silently dropping them. This is schema adaptation, not an automatic interpretation of every possible JSON format.

CSV endpoints, scoped to the organisation and venue:

- `POST /api/orgs/:slug/venues/:venueId/halls/import/csv/preview` accepts `{ content, mapping? }` and returns per-row conversion results and a preview token.
- `POST /api/orgs/:slug/venues/:venueId/halls/import/csv` accepts the same file/mapping, chosen `halls`, `reviewed: true` and the current preview token. The token includes existing hall versions.

CSV source identities are scoped to the destination venue, versions record `source: 'csv'`, and saves emit `hall.csv_imported`. Repeat unchanged imports create neither a duplicate hall nor a new version. CSV provenance is added by the registered `CsvFloorSource1791700000000` migration.

The JSON adapter and endpoints remain for API compatibility:

- `POST /api/orgs/:slug/venues/:venueId/halls/import/json/preview` accepts `{ content, mapping? }` and returns converted halls, per-hall errors, warnings and a preview token.
- `POST /api/orgs/:slug/venues/:venueId/halls/import/json` accepts the same data plus `halls`, `reviewed: true` and the preview token. Current hall versions participate in the token; stale previews cannot overwrite a newer floor.

Native JSON source IDs are scoped to the destination venue. Named halls without IDs are matched by source name; unnamed halls without IDs only match the identical uploaded file. Preview exposes an existing match as an update. Reimporting unchanged data adds neither a hall nor a floor version. JSON-created floor versions use `source: 'json'` and an audit event. The prior ITPO endpoints remain for API compatibility; the old frontend dialog has been replaced.

File size is limited to 12 MB, up to 500 hall records, with bounded geometry and annotation arrays. Mapping paths reject prototype traversal. Canonical geometry is validated before saving. Tests cover generic units/mappings, holes/foyers, colour meanings, export round-trips, unsupported shapes, source identity, organisation/venue access, stale previews and versioned saves.
