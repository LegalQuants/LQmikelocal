# Phase 11 — Document Graph: LLM Citation Extraction
Status: DONE

## Goal
Wire up the `/projects/:projectId/links/extract` endpoint to call the LLM, returning a list of proposed `{source, target, link_type, citation_text}` edges. Add a "Detect citations with AI" toolbar button in the graph view that opens a review modal where the user accepts/rejects each proposal before they're persisted via `/links/bulk`.

## Tasks
- [x] Replaced the extract stub with a real LLM call (`completeText`).
- [x] Pre-load per-doc text via existing `loadCurrentVersionBytes` + `extractPdfText` / `extractDocxBodyText`; trim to 3000 chars each.
- [x] Single-response JSON prompt (no streaming, no tool loop).
- [x] Validate proposals (resolve compact `D1/D2` tags → UUIDs, enforce allowed link_types) and de-duplicate against existing links.
- [x] Added `extractDocumentLinks` + `bulkCreateDocumentLinks` + `LinkProposal` type to `mikeApi.ts`.
- [x] Built `ExtractProposalsModal.tsx` (per-row checkbox, select-all/clear, AI badge, citation snippet).
- [x] Wired "Detect citations with AI" button into the graph toolbar; persists via `/links/bulk` and pushes new edges into state.
- [x] Bumped `package.json` to 0.3.4.

## Acceptance Criteria
- [x] Button hits backend, gets proposals, opens the review modal.
- [x] Modal shows source / target / type / citation snippet with per-row toggle + bulk accept.
- [x] Approved proposals POST to `/links/bulk`; new edges appear with the AI styling (orange + animated).
- [x] `npx tsc --noEmit` clean in both backend (`backend/`) and frontend (`frontend/`).

## Decisions Made This Phase
- **Model selection:** routed through `getUserModelSettings(...).tabular_model` — the same mid-tier the user already picks for tabular reviews. Reuses existing key-resolution and respects the user's preference without a new setting.
- **Compact doc tags (`D1`, `D2`):** the prompt asks the model to refer to documents by a short tag rather than full UUIDs. Two reasons: it (a) saves tokens, and (b) makes us robust to truncation — a partial UUID would silently mis-map; a partial `D17` is rejected by `tagToId.get`.
- **No streaming, no tool loop:** this is a one-shot JSON extraction task; `completeText` is simpler than `streamChatWithTools` and avoids the multi-turn dispatch machinery for no benefit.
- **Cost discipline:** 40-doc project cap per call (returns 400 above that); per-doc text capped at 3000 chars; `maxTokens: 2048` on the response. Larger projects defer to a future chunked pass.
- **Defaults-on selection in modal:** the modal pre-checks all proposals so a user with a small project can accept everything in one click. Toggling individual rows lets larger reviews stay precise.
- **De-dup against existing links:** the endpoint filters out proposals whose `(source, target, link_type)` already exists, so a second extraction pass doesn't waste the user's review time on edges they already accepted.
