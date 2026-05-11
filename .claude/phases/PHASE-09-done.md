# Phase 09 — Document Graph: DB + Backend
Status: DONE

## Goal
Introduce a `document_links` SQLite table plus per-project link CRUD endpoints, so the renderer has a persistence layer to build the graph view against. No frontend or LLM work this phase.

## Tasks
- [x] Add `backend/migrations/004_document_links.sqlite.sql` (table + indexes + cascade FKs + unique constraint).
- [x] Add `GET /projects/:projectId/links` (lists links for the project).
- [x] Add `POST /projects/:projectId/links` (manual link create; validates both docs belong to project; `created_by='user'`).
- [x] Add `DELETE /projects/:projectId/links/:linkId` (creator or project owner).
- [x] Add `POST /projects/:projectId/links/bulk` (persist accepted LLM proposals; `created_by='llm'`).
- [x] `POST /projects/:projectId/links/extract` stub that returns `{ proposals: [] }` — real LLM call lands in Phase 11.
- [x] Bump `package.json` version 0.3.1 → 0.3.2.

## Acceptance Criteria
- [x] Migration applies cleanly (validated against in-memory sqlite — cascade delete works, UNIQUE (source, target, type) works, CHECK on `created_by` works).
- [x] Routes follow the existing access-control pattern (`checkProjectAccess`) and shim conventions.
- [x] `npx tsc --noEmit` in `backend/` passes cleanly.
- [x] All four routes return correct 2xx/4xx for happy and error paths (in-project doc validation, duplicate-link → 409, cross-user delete → 403).

## Decisions Made This Phase
- **Migration filename:** `004_document_links.sqlite.sql` (not `002_*` as originally planned — `002` and `003` were already taken by workflow migrations). The migration runner's glob is `^\d+_.+\.sqlite\.sql$` so the new file gets picked up automatically.
- **No CHANGELOG.md:** repo doesn't maintain one (the only prior release commit just bumped `package.json`); followed precedent rather than introducing a new file.
- **link_type vocabulary:** curated list of six (`references, amends, supersedes, exhibit-of, cited-by, related`) normalised case-insensitively, but free strings up to 64 chars allowed so users aren't boxed in. Documented in `normaliseLinkType()`.
- **Delete authorization:** link creator OR project owner can delete; shared members can't erase other members' links. This is stricter than "any project member can delete" and matches the spirit of the per-user-id pattern used elsewhere in projects.ts.
- **Duplicate handling:** manual POST returns 409 on UNIQUE violation; bulk POST silently skips dupes (returns them in `skipped[]` with `reason: 'db_error'`) so re-running an LLM extraction is idempotent.
