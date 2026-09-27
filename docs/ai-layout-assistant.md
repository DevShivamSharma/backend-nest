# AI layout assistant POC

`POST /api/layout/assist` accepts the existing Angular `{ requirement, hall, existingStalls }` contract and returns `{ summary, notes, stalls }`. Optional response metadata includes `action`, `requestedCount`, `placedCount`, `clarification`, `removals` and `source`. No database writes occur in this endpoint.

The model produces a strictly validated intent only. The new planner scans snapped positions and calls the existing placement validator. It preserves the authoritative hall boundary, masks, zones, openings, existing rotated stalls, event rules and passages. Proposals also meet the interactive planner's default peripheral clearance. Fixed obstacles are subtracted once into equivalent usable polygons before candidate validation; no existing geometry or rule implementation is modified.

The frontend shares one session between Assist and the floating button. Proposals are outlines until Apply. Apply repeats `reviewPlan` and uses `applyPlan`; removals use the normal cancellation/removal path. A changed hall expires pending proposals, and changed stalls invalidate removal approvals. Chat history is discarded when the planner page is destroyed.

## Configuration

Set these in the backend's ignored `.env`, then restart the backend:

```dotenv
AI_PROVIDER=groq
AI_API_KEY=your-server-side-key
AI_MODEL=openai/gpt-oss-20b
```

| Provider | AI_PROVIDER | Example AI_MODEL |
| --- | --- | --- |
| Google Gemini | `gemini` | `gemini-2.5-flash` |
| Groq | `groq` | `openai/gpt-oss-20b` |
| xAI Grok | `grok` | `grok-4-1-fast-non-reasoning` |

Choose a model enabled for your account. Model availability and free-tier limits are provider-controlled. The originally suggested Llama model was absent from the supplied Groq account's model list during verification. No key reaches the browser. Gemini uses `x-goog-api-key`, JSON MIME type and `responseSchema`; Groq and Grok use OpenAI-compatible JSON mode. All results pass the same strict runtime validator.

Leave `AI_API_KEY` blank for the simple parser. Startup does not require AI configuration. Provider errors, invalid replies or the shared 15-second deadline fall back to that parser, with a visible note. Invalid JSON/schema receives one retry within the same deadline. Raw provider errors and keys are never logged or returned. Logs contain bounded structured intent metadata.

The POC rate limit is 10 requests per IP per minute in each backend process. Requirement length is 500 characters; proposals are capped at 500 stalls. The placement scan has candidate and elapsed-time limits and explains when it stops. This is a greedy fit, not a global packing optimiser. Large halls may need multiple smaller-area requests. Unknown or ambiguous markers require clarification. Source-drawing floor islands outside the authoritative saved boundary remain unavailable; the assistant never relaxes existing save rules to use them.

## Examples

- `12 stalls of 3x3 near FOYER-1G`
- `20 stalls of 3x3 along the left wall, 4 m aisles`
- `2 rows of 6x4 shops along the west wall`
- `Fill the hall with 3x2 stalls`
- `Clear all stalls` (review removals, then Apply)

Use markers that exist in the selected hall. Spatial directions use plan axes: north is -Z, south +Z, west -X, east +X. Open side names use the planner's existing FRONT/BACK/LEFT/RIGHT convention. Existing event rules take precedence over the aisle width requested in text. The present application defaults both B2B and B2C to 3 m, so that behavior is preserved.

The simple parser understands numeric counts/sizes, rows, wall directions, markers, foyers, aisle widths and open sides. It does not implement multi-turn references, semantic stall filters, move/resize/rotate commands, mixed stall types or optimal packing. The LLM receives only the current request and a bounded hall summary, not the chat history. Apply inherits the store's current behavior; this feature does not add a separate undo system.

## Verification

Provider calls are mocked in tests. New tests cover malformed intents and requests, parser behavior, wall and marker placement, floor islands, obstacles, zones, circular halls, snap grids, existing stalls, clear proposals, fallback, retry, timeout and the HTTP rate limit. Frontend tests cover loading, send, Apply/Discard, shared session history, stale responses, hall changes and removal safeguards.

Run backend `npm test -- --runInBand`, `npm run test:e2e -- --runInBand`, and `npm run build`. Run frontend `npm test -- --watch=false --browsers=ChromeHeadless` and `npm run build`.

Provider references: [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [Groq API reference](https://console.groq.com/docs/api-reference), [xAI chat completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions).
