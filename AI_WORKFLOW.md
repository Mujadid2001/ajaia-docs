# AI workflow note

**Tools:** Claude (chat + code execution) used as a pair programmer for scaffolding, implementation and test drafting.

## How I used it
- **I made the product and architecture decisions first**: stack, the 404-vs-403 policy, role model, optimistic locking, server-side sanitization, and the explicit scope cuts. AI was asked to implement against those, not to choose them.
- AI generated the first pass of the API, importers, SPA and tests. I reviewed each module against the requirement list instead of accepting it wholesale.
- Tests were written to assert **behavior I care about** (stranger gets 404, viewer gets 403, revoke works, stale write gets 409, `<script>` is stripped), not just happy paths.

## What I verified myself
- Ran the test suite and a server smoke test (static assets, vendor bundle, API) rather than trusting generated code.
- Caught and fixed a test-runner issue (`node --test test/` treats a directory as a module on Node 22).
- Manually walked the demo script in the README across two browser sessions.

## What I rejected or changed
- Avoided `contenteditable`/`execCommand` (deprecated) and a CDN-loaded editor; vendored Quill instead for reliability.
- Avoided `innerHTML` for user data in the UI; kept it only for static toolbar markup.
- Didn't let AI inflate scope (real-time sync, comments, etc.). Those are documented as next steps.

## Judgment calls on AI output
Generated code is treated like a junior's PR: security-sensitive paths (auth cookie, sharing checks, sanitization, upload limits) got line-by-line review; boilerplate (CSS, DOM helper) got lighter review.
