# Decisions

## 2026-05-01 — Fork mikelocal as Electron desktop app
**Chosen:** Wrap the existing Next.js + Express stack in Electron as a downloaded Windows app.
**Alternatives:** Tauri (Rust shell — would require rewriting backend or running it as a sidecar with extra complexity), web app stays as-is (not what user wants), Flutter+local-server (bigger rewrite).
**Why:** Electron preserves the existing Next.js + Express code with minimal rework. Renderer talks to Express on a localhost port — same code path as web. Tauri's binary-size win doesn't justify rewriting backend.
**Trade-offs:** Larger installer (~150–200 MB), higher RAM use than Tauri.
**Revisit if:** Installer size becomes a blocker or non-Windows targets demand smaller footprint.

---

## 2026-05-01 — SQLite (better-sqlite3) replaces Supabase Postgres
**Chosen:** `better-sqlite3` for local single-user storage.
**Alternatives:** Embedded Postgres (PGlite or pg-mem — heavy and non-standard for desktop), `sqlite3` (async; slower for the read-heavy workload), JSON-file storage (insufficient for relational schema).
**Why:** Single file, synchronous API matches existing imperative route code, fastest option, mature, no external server, ports cleanly from Postgres for our schema scope.
**Trade-offs:** Schema port required (RLS dropped, JSONB → TEXT, UUID → TEXT, plpgsql triggers rewritten). Native module needs Electron-version rebuild.
**Revisit if:** Multi-user or sync requirements appear, or schema needs Postgres-only features we currently don't use.

---

## 2026-05-01 — Local auth: Node scrypt password + per-launch random JWT
**Chosen:** scrypt password hash stored in `<workspace>/.mike/auth.json` (PHASE-02). On unlock, Electron mints a fresh random 32-byte JWT secret and signs an HS256 token; backend gets the secret via env at spawn, verifies via the same secret (PHASE-03). No `jsonwebtoken` dep — ~50 lines of `crypto.HMAC` covers it.
**Alternatives:** bcryptjs (pure-JS dependency, no benefit over built-in scrypt), native bcrypt (extra native module to rebuild for Electron), JWT secret derived from password (more code, no real security gain — losing the in-memory secret is fine), session cookies (cookies in Electron renderer are awkward), OS keychain only (no logout/lock flow).
**Why:** scrypt ships in Node `crypto` — zero extra dependencies, memory-hard. Random per-launch JWT secret is simpler than deriving from password and matches the actual threat model (the lock screen gates whether you ever get a token; the token's lifetime is the process). The shared-secret backend pattern lets Electron own the auth lifecycle while the existing Express middleware shape stays unchanged (just swap the verifier).
**Trade-offs:** scrypt is ~2× slower than bcrypt at our params (acceptable: only runs on unlock). Tokens don't survive across launches — user re-enters password each launch (acceptable: that's by design).
**Revisit if:** Multi-account-per-workspace becomes a goal, or password reset (without losing data) is requested, or scrypt unlock latency feels slow on low-end machines.

---

## 2026-05-01 — API keys stored in SQLite (per-user_profiles row), not safeStorage
**Chosen:** LLM API keys live in `user_profiles.claude_api_key` / `gemini_api_key` columns of `<workspace>/.mike/mike.db` — same place the upstream cloud version stored them. The Settings UI at `/account/models` patches them via `PATCH /user/profile`. Routes load keys via the existing `getUserApiKeys(userId)` helper.
**Alternatives:** `safeStorage.encryptString` to `secrets.enc` + spawn-time env injection (the originally-planned PHASE-02/06 design), `keytar` (third-party, unmaintained on Windows), per-key OS keychain entries (cross-platform fragmentation).
**Why:** Keys are already gated by the workspace password (scrypt-hashed `auth.json` blocks the lock screen). Encryption-at-rest beyond that adds complexity (backend-to-Electron IPC for every save, backend restart on key change) without meaningfully raising the bar against an attacker with filesystem access — they'd need to crack the password to use the app anyway. SQLite-resident keys also reuse the existing `getUserApiKeys` plumbing the upstream cloud version already had — zero schema or call-site changes.
**Trade-offs:** Anyone with raw filesystem access to the workspace can read the API keys plaintext. This is no worse than the upstream cloud version, where keys lived in Supabase Postgres (also reachable with the right credentials). For multi-user laptops where another person might browse files, a separate workspace per OS account remains the recommendation.
**Revisit if:** A user explicitly wants encryption-at-rest for keys (then add a PHASE-09: `safeStorage`-encrypted column with a derived encryption key, decrypt on read).

---

## 2026-05-01 — LibreOffice NOT bundled; runtime detection
**Chosen:** Probe for `soffice` at backend startup; if absent, disable DOC/DOCX upload paths and surface a friendly "Install LibreOffice" banner with download link.
**Alternatives:** Bundle a portable LibreOffice (~400 MB), bundle a smaller converter (no good FOSS option for DOC/DOCX→PDF), require LibreOffice install before app run (bad UX for non-technical users).
**Why:** A 400 MB installer for a feature many users won't hit on day one is a worse trade than graceful degradation. PDF/TXT covers the common case.
**Trade-offs:** Some users will hit the missing-LibreOffice error and bounce.
**Revisit if:** Telemetry (or user feedback) shows DOCX upload is the primary entry point.

---

## 2026-05-01 — Drop Cloudflare/OpenNext deploy path
**Chosen:** Remove `@opennextjs/cloudflare` and `wrangler` from frontend; bundle plain Next.js into the Electron resources directory.
**Alternatives:** Keep both (dead code, larger install), use OpenNext locally somehow (not supported).
**Why:** This fork is desktop-only. Keeping the cloud deploy path adds dead deps and confuses future readers.
**Trade-offs:** If someone wants to also deploy this version to Cloudflare, they'll need to re-add it. They have the upstream repo for that.
**Revisit if:** A user explicitly wants both targets.

---

## 2026-05-01 — Windows-first; macOS/Linux deferred
**Chosen:** Ship a Windows NSIS installer for v1. macOS / Linux builds parked.
**Alternatives:** Cross-platform from day one (more testing, code-signing complexity per platform, more time).
**Why:** User is on Windows; matches their immediate need. Electron + electron-builder makes adding the other targets a config change later.
**Trade-offs:** Other-OS users can't install yet.
**Revisit if:** A user asks for macOS or Linux build.

---

## 2026-05-01 — No code signing for v1
**Chosen:** Ship unsigned `.exe`. README documents Windows SmartScreen warning + how to bypass.
**Alternatives:** Buy an Authenticode cert (~$200–400/yr), use Azure Trusted Signing (~$10/mo, requires verified org).
**Why:** Personal project; user wants to ship now. Cost not yet justified.
**Trade-offs:** SmartScreen friction for first-time users — real UX cost for non-technical audience.
**Revisit if:** App is distributed beyond the user's own machine, or if the SmartScreen warning prevents adoption.

---

## 2026-05-01 — License remains AGPL-3.0-only
**Chosen:** Keep the upstream AGPL-3.0 license unchanged. All derivative source remains open.
**Alternatives:** None viable — AGPL-3.0 mandates derivative works also be AGPL-3.0.
**Why:** Required by upstream license.
**Trade-offs:** Cannot ship a closed-source variant.
**Revisit if:** N/A (license is binding).

---

## 2026-05-03 — `auth-state.json` lockout state is a UX rate-limit, not an offline-attack defense
**Chosen:** Persist the failed-attempts counter and lockout deadline in plaintext at `<workspace>/.mike/auth-state.json`. An attacker with filesystem access can edit or delete the file to reset the counter.
**Alternatives:** HMAC the state file with a key derived from `auth.json`'s stored hash, so tampering invalidates the state and forces a wait; or keep the counter purely in memory (no persistence across launches).
**Why:** The lockout exists to slow down an interactive human at the lock screen who has fat-fingered or is shoulder-surfing — not to defend against an offline brute-force attempt. The real defense against offline attack is `scrypt` with `N=131072, r=8` (~400 ms per derive, ~128 MB working set), which is configured in `electron/auth.ts`. An attacker who can read `auth.json` from disk can already attempt scrypt offline at their own pace; deleting `auth-state.json` doesn't speed that up. Adding HMAC machinery would suggest a security guarantee the file does not provide.
**Trade-offs:** A user (or someone with shell access) can bypass the 30-second wait between tries by deleting the file. That is the documented behavior, not a bug.
**Revisit if:** Lockout becomes an actual security control (e.g. if password requirements are relaxed, scrypt params are weakened, or the workspace is shared between users), in which case HMAC the state file with a key derived from `file.hash`.


---

## 2026-05-09 — DOCX redline + comment markers exposed to LLM in extracted text
**Chosen:** `extractDocxBodyText` (in `backend/src/lib/docxTrackedChanges.ts`) emits `{++inserted++}`, `{--deleted--}`, and `{>>by AUTHOR: body<<}` markers inline when a DOCX contains tracked changes or Word comments. The system prompt teaches the model to recognize the markers and to strip them when forming `find` / `context_before` / `context_after` for `edit_document`.
**Alternatives:** Add a separate marker-aware extractor and only call it from a new tool (extra surface area, two ways to read a doc); render markers as a UI overlay in the document preview pane (frontend work, separate from LLM awareness); port the upstream fork's Python+PyMuPDF PDF redline detector (adds Python runtime dependency to a previously single-binary app).
**Why:** Ported from `jamietso/mike-redline` so the LLM can reason about prior redlines and comments rather than seeing flattened accepted-view text. Lives entirely server-side in the existing extractor — no schema change, no new endpoint, no frontend change, no new runtime dependency. The matcher in `applyTrackedEdits` does its own marker-free flattening, so existing `edit_document` accept/reject flows keep working unchanged.
**Trade-offs:** Author names in `w:author` are surfaced verbatim to the model — this is intentional (the LLM should know who proposed what), but if a DOCX from an external counterparty embeds personal names, those names enter the model context. PDF redlines are out of scope for this change (no Python runtime). System prompt grew by ~7 lines, adding a small per-request token cost.
**Revisit if:** A real document hits the model's context limit because of marker bloat (tens of thousands of tracked changes), or PDF redline awareness becomes a hard requirement, or a privacy review concludes author surfacing should be configurable.
