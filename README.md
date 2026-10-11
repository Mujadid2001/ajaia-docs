# Ajaia Docs — lightweight collaborative document editor

Create, rich-text edit, import, and share documents. Node + Express + SQLite, vanilla JS + Quill on the front end.

**Live URL:** see `LIVE_URL.txt` (pending — Render needs payment info on the workspace before it will create the service) · **Walkthrough:** see `walkthrough_video_url.txt` (outstanding, not yet recorded)

## Run locally
Requires **Node 22.12+** (tested on 22.23). Older runtimes cannot load the
`better-sqlite3` native module — the app exits with a clear message instead.
```bash
npm install
npm start          # http://localhost:3000
npm test           # 12 API/integration tests, in-memory SQLite
```
Optional env: `PORT`, `DB_PATH` (default `./data/app.db`), `SESSION_SECRET`.

## Demo script (2 minutes)
Auth is **mocked**: pick one of three seeded users (alice / bob / carol `@ajaia.test`). Use two browser profiles (or one normal + one private window) to be two users at once.
1. As **Alice**: *New document*, rename it, format text (headings, bold/italic/underline, lists). Refresh — it persists.
2. *Upload file* with a `.md`, `.txt` or `.docx` → becomes a new editable document.
3. Open a doc → *Share* → `bob@ajaia.test` as **Can view**.
4. As **Bob**: it appears under *Shared with me* with a role badge; the editor is read-only. Alice upgrades him to **Can edit**; Bob can now edit.
5. Carol cannot open the doc by URL (404). Alice can remove Bob's access.

## Features and deliberate limits
| Area | Included | Not included (on purpose) |
|---|---|---|
| Editing | Title rename, H1–H3, bold/italic/underline, bullet/numbered lists, clear formatting, debounced autosave | Tables, images, comments, history, real-time cursors |
| Upload | `.txt`, `.md`, `.docx` (≤ 2 MB) → new document; supported types are stated in the UI | PDF, attachments, import into an existing doc |
| Sharing | Owner, share by email with viewer/editor role, revoke, owned vs shared lists | Link sharing, groups, ownership transfer |
| Persistence | SQLite; HTML content (sanitized server-side); versioned saves | Revision history |
| Concurrency | Optimistic locking: a stale save gets a 409 and a "Reload latest" banner | Live merge/CRDT |

`.docx` import goes through Mammoth, so complex layout (tables, images, comments) is dropped; text, headings, bold/italic/underline and lists survive.

## API
`POST /api/login` · `GET/POST /api/documents` · `POST /api/documents/import` · `GET/PUT/DELETE /api/documents/:id` · `POST /api/documents/:id/shares` · `DELETE /api/documents/:id/shares/:userId`

`PUT` is a compare-and-swap: it requires the `version` you last read and answers `409` if someone else saved in between. `GET/PUT/DELETE` return **404** (not 403) when you have no access, so document IDs never leak.

## Deploy
Any Docker host works. For Render (free): push this repo to GitHub → *New → Blueprint* → select repo (`render.yaml` is picked up). Free-tier disks are ephemeral, so data resets on redeploy; the three demo users are re-seeded on boot. For durable data, attach a disk at `/data` (paid) or swap SQLite for Postgres.

The image installs with `npm ci --ignore-scripts` so npm does not auto-run a `node-gyp` stub build for `better-sqlite3` (the slim base image has no Python or C++ toolchain). The prebuilt binary is used instead. See the comment in `Dockerfile`.

## Known advisories
`npm audit` reports 3 moderate advisories, all from one chain: `mammoth → argparse → sprintf-js` (GHSA-hp3w-g68c-fv3c, a DoS via unbounded printf precision). No patched `sprintf-js` exists yet, and the suggested fix is to downgrade Mammoth to `0.3.x`. Not done deliberately — it would trade a document importer for a decade-old build. Content from a `.docx` never reaches `sprintf-js` with user-controlled format strings. Re-check once an upstream fix lands.
