# Manual hall annotations

**Add hall → Draw by size** creates a rectangular hall with a 1 m grid. Its Three.js preview supports toilet, stairs, lift, exit, drinking-water and information cards, custom text labels, and coloured legend entries. Select a helper to rename it, set its coordinates or size, click **Place on layout**, or drag the card. Legends appear in the panel beside the grid. Helpers can sit inside or outside the hall; they are annotations and do not reserve physical floor space.

`POST /api/orgs/:slug/venues/:venueId/halls` accepts optional `annotations: { labels, iconGroups, legend }`. These use the existing `floor/1` fields in metres, with the top-left hall corner as `(0, 0)` and Y increasing downwards. Annotated blank floors include rectangular `geometry/1` so the saved viewer uses the same Three.js rendering as the creation preview. No database migration is required.

For manually drawn halls, **Edit details** reopens the same editor. `PATCH /api/orgs/:slug/halls/:hallId` accepts annotations with `expectedVersion`. A changed layout adds a floor version while preserving its dimensions, geometry, restrictions and source. Unchanged annotations do not add a version; a stale version is rejected. Prior floor versions remain available.

The API validates coordinates, positive annotation sizes, supported icon kinds, plain text, legend colours and bounded arrays. HTTP tests cover persistence, readback, history, stale updates, permissions and invalid annotation payloads. Browser tests exercise placement, dragging, size changes, creation, saved rendering, subsequent edits and narrow-screen controls.
