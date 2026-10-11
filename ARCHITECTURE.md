# Architecture note

## Shape
Single Node process: Express serves a JSON API and the static SPA. SQLite (better-sqlite3) stores `users`, `documents`, `shares`. No build step; Quill is served from `node_modules`, so there are no runtime CDN dependencies.

## What I prioritized, and why
1. **Authorization correctness over feature breadth.** One function (`roleFor`) decides owner/editor/viewer; every route goes through `load(req, {need})`. Users with no access get **404, not 403**, so document IDs don't leak existence. This is the part that is expensive to retrofit and the part tests cover most heavily.
2. **Safe persistence of rich text.** Content is stored as HTML, sanitized on the server with an allow-list matching what the editor can emit. This blocks stored XSS from pasted/imported/API-crafted content. Imports (`.md`, `.docx`, `.txt`) pass through the same sanitizer. Client renders user strings via `textContent` only.
3. **Don't lose data silently.** Autosave is debounced and flushes on blur/tab-hide; `beforeunload` warns on unsaved changes. Saves carry a `version`; the update is a compare-and-swap, so concurrent editors get a clear 409 instead of last-write-wins data loss.
4. **A usable editor within scope.** Quill gives a coherent toolbar, keyboard shortcuts and undo/redo for free; I spent time on flow (autosave status, read-only mode for viewers, empty states, error messages) rather than on a custom editor.

## Deliberate cuts
- **Mock auth** (seeded users + HMAC-signed httpOnly cookie). Production: OIDC/SSO, CSRF protection on state-changing routes (currently relies on `SameSite=Lax` + JSON content type), rate limiting.
- **No real-time collaboration.** Proper multi-cursor editing needs a CRDT/OT layer (Yjs + websocket provider). Optimistic locking is the honest intermediate step.
- **HTML as storage format.** Pragmatic and portable at this scope. At scale I'd store the editor's structured document model (e.g. ProseMirror JSON/Yjs state) for reliable merging and diffing.
- **Sharing by email to existing users only**, no invitations to unknown addresses.
- **SQLite on an ephemeral disk** for the free deployment. The data layer is ~40 lines of SQL, so a Postgres move is mechanical.

## Known risks / next steps
Add document revision history; Yjs for real-time; Playwright E2E for the editor flow (current automated tests cover the API and access logic, not browser UI); audit log for sharing changes; pagination on document lists.
