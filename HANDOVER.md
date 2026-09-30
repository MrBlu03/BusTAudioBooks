# BusTAudioBooks — Handover Brief
Commit `3e90f43`, tree clean, nothing pushed. Freshly built image verified running in the container.

## 1. Standing constraints — do not break these
- **No GitHub work.** `AFK-Goblin` is not the user's account. Commits stay local on `main`. Never push, create a repo, or install `gh`.
- **No server-side TORBOX_API_KEY change.** The key is per-user via the install URL. Deliberate, explicitly reaffirmed.
- **No bursting index requests.** The index rate-limits hard and answers a burst with an empty page. `RECS_GAP_MS` defaults to 2500, must stay ≥ 2000.
- **Public exposure left as-is.** User declined `ACCESS_TOKENS` gating.

## 2. Verified state
| Check | Result |
| --- | --- |
| `npm test` | 163 pass, 0 fail |
| `npm run test:serve` | all checks passed |
| Manifest | v2.5.1, 45 genre options, recs advertised |
| Recs resolution | 14 of 14 |
| Recs serving | 14 across 2 pages (`PAGE_SIZE = 12`) |
| Series Reading Orders | Dynamic dual orders verified for Foundation (1951..1993 Release vs Prelude..Earth Chronological) & Narnia; canonical 6 books for Dune without spinoff duplicates |
| Episode ID Uniqueness | Verified globally unique episode item IDs across Season 1 and Season 2 via season discrimination |
| Search Prioritization | Searching a series or a book in a series (e.g. "Dune Messiah", "Second Foundation") prepends the full series card at #0 |
| Search Deduplication | Dynamic deduplication collapses duplicate releases and duplicate collection packs cleanly |
| Reliability & Hardening | Resilient timeouts on TorBox and Jackett fetches; client disconnect guards in Express handlers; safe array checking on torrent files; HTML entity decoding and zero-width/NBSP whitespace cleaning |
| Containers | `backend`, `jackett`, `flaresolverr`, `warp` — all Up |

Genre rows sampled live: Horror / In Your TorBox / Popular Series / Science Fiction / Stephen King / Recommended For You all return n=12; recs page 2 returns n=2. Recs by source: 8 infohash, 0 magnet, 6 torrentUrl.

## 3. What was actually wrong — three faults, each independently fatal
`.recs.json` was stuck at 0 items.

1. **The reachability precheck gated on the wrong thing.** `refresh-recs.js` probed the direct ABB mirror and `process.exit(1)`'d if down. But resolution runs through `searchAudiobooks()`, which fans out to mirror and Jackett and merges whatever survives `allSettled`. A dead mirror is survivable — the old guard called a working Jackett setup "unreachable" and exited before one lookup. Now `probeSearchPath()` asks the only question that predicts success: does a real search return anything?
2. **`JACKETT_URL` doesn't resolve on the host.** `.env` has `http://jackett:9117` — a compose-network name. Works in the container (which is why the catalogue always worked), fails on the host where the script runs. `jackettUrlForHost()` detects this and falls back to the published `127.0.0.1:9117`. `.env` deliberately untouched — the container still needs the internal name.
3. **`torrentUrl` was being discarded.** `searchJackett()` intentionally keeps results with neither infohash nor magnet, since Jackett returns a `/dl/` endpoint resolved at play time. `resolveRecs()` persisted only infohash/magnet, so every Jackett-only hit was written with no way to fetch it, then filtered away as unplayable. That silently lost 6 of 14 items. Both sides now carry `torrentUrl` as a third valid source.

## 4. Design decisions worth not undoing
- **Resolution is offline, never in-request.** In-request resolution fired one search per rec simultaneously; the index returns an empty page for a burst. Measured: *A Game of Thrones* resolves alone, returns nothing in a batch of sixteen.
- **A wrong tile is worse than a short row.** `titleMatches()` rejects any hit that isn't the book asked for. The recs row no longer falls back to hardcoded `FEATURED_AUDIOBOOKS` — that was showing arbitrary popular titles as personal picks. Row is only advertised when it has playable entries.
- **Jackett is a first-class source, not a fallback.** Earlier notes in the repo said it "contributes nothing" — that is wrong. It is currently the only working path to the index.
- **Generation and resolution are decoupled.** The hash gate exists to save tokens, but both were under one gate, so a run that resolved nothing was preserved as zero items forever. Suggestions are now stored alongside resolved items; an unchanged library with 0 resolved re-resolves without calling the model. `resolvedAt` is tracked separately from `generatedAt`.
- **`.recs.json` is bind-mounted read-only into the backend.** It's gitignored and host-generated, so it was never in the image — every refresh previously needed a rebuild.
- **Metadata order: Libex → iTunes → Google Books → Open Library → Wikipedia.** Libex match gating is exact normalised title only; author only boosts; non-English × 0.25. Token-overlap and prefix matching both produced series false positives — don't reintroduce. `audiobookcovers.com` was removed as a poster source (returns 20 results for invented titles, no metadata, score isn't relevance).

## 5. Open items
1. **The original 400 needs the user.** `TORBOX_API_KEY` is empty and the install URL carries no config → every `/catalog` and `/meta` returns "Missing or invalid configuration. Re-install the addon." Fix is re-installing via `/configure`. Config gotcha that cost me time: the key is a base64url path segment with field `apiKey` (camelCase), not `torbox_api_key`, and not a `config=` query param. A 400 with a well-formed config almost always means the wrong field name.
2. **Genre seeds unverified.** `test/genres.live.js` walks all 44 but never completed — earlier probing got rate-limited. Worth running now that Jackett works.
3. **Recs row display names cleaned:** `src/index.js` uses `prettyName(rec.title)` so clean book names are shown instead of raw index tags.
4. **`flaresolverr` is unused** — healthy at `http://flaresolverr:8191`, no code references it despite the compose comment. Confirm before removing.
5. **Recs aren't user-specific at serve time** — one shared `.recs.json`, so on a shared install everyone's row is the credential owner's.

## 6. Tooling gotchas that cost time
- **PowerShell 5.1:** `&&` invalid (use `;`); nested quotes in `docker exec sh -c "node -e \"...\""` break — write a script file; apostrophes break single-quoted commit messages; `Set-Content -Encoding UTF8` writes a BOM that lands in the commit message (use `-Encoding ASCII`).
- **opencode CLI is not on PATH:** `C:\Users\james\AppData\Local\Programs\@opencodedesktop\resources\opencode-cli.exe` (v2.0.19). Use `spawn` with `stdio: ["ignore","pipe","pipe"]` — `execFile` hung 180s with no output while `spawn` returns in 2–3s (state dir holds an `opencode.db` SQLite).
- **Models:** `opencode/space-bunny-free` (default, best-behaved), `mimo-v2.6-flash-free`, `muse-spark-1.3-contributor-free`, `nemotron-3.5-lightning-free`, `longcat-2.5-preview-free`. Avoid `opencode/ling-3.0-flash-fin-free` — unparseable JSON.
- **Truncation is real** — models run out mid-string (`"reason":"Same lone-`). `extractJson` falls back to balanced `{...}` extraction; keep it.
- **`isPlausibleTitle()` drops model padding** ("Project Hail Mary's companion: The Martian"). 0 dirty titles across both models tested.

## 7. Security — confirm these actually happened
- Jackett key still in git history at `8d7233b` and earlier. Untracked going forward and compose now reads `${JACKETT_API_KEY:-}`, but history rewriting was not authorised. User said they'd rotate it.
- Nuvio credentials were pasted into chat; they live in gitignored `.env`. Rotation was recommended and needs confirming.

## 8. Commits (newest first)
- `3e90f43` feat: fix series release orders, prioritize series in search, and deduplicate results
- `e8679ab` feat: default recommended series books to series view with deduplication
- `af80740` feat: implement dual chronological and release reading orders and daily recommendation refresh
- `9cddef2` feat: implement dynamic metadata-driven catalogs with scheduled regular refreshes
- `85602cf` feat: attach respective book covers to episodes and collection cover to series
- `20c41bf` feat: prioritize book series in search results when query matches a book series
- `573e218` feat: implement metadata-level series generation and dynamic episode torrent resolution
- `d1cfb54` feat: implement dynamic episodic series for multi-book collections without hardcoding
- `74da3e5` Resolve recs through Jackett when the mirror is dead
- `f138cd8` Salvage truncated model output; check the index is up first
- `de67a14` Resolve recs offline, filter malformed titles, gate the row
- `bc39cd3` Add AI recommendations from the Nuvio audiobook library
- `7f689ea` Add Nuvio Cloud API client
- `c23a078` Better metadata (Libex) and a real genre table
- `8712bbc` checkpoint: comic feature + untrack Jackett runtime config
- `8d7233b` Comic addition

## 9. Key files
| File | Role |
| --- | --- |
| `scripts/refresh-recs.js` | generation + offline resolution. Exports `extractJson`, `normaliseRecs`, `isPlausibleTitle`, `buildPrompt`, `runModel`, `checkSourceReachable`, `probeSearchPath`, `jackettUrlForHost` |
| `src/recs.js` | read side — `getRecs`, `hasRecs`, `searchTermFor`, `titleMatches`, `cutSubtitle` |
| `src/index.js` | RECS branch (zero network work), manifest, configure, express error handler |
| `src/sources.js` | `searchAudiobooks` fans out ABB + Jackett; `abbFetch` 2s timeout, `pLimit(5)` |
| `src/genres.js` | 44 categories + RECS kind |
| `src/manifest.js` | `buildManifest({withRecs})`, v2.4.0 |
| `src/libex.js` | Audible metadata provider (highest priority) |
| `src/nuvio.js` | Nuvio Cloud client, delta pull, auth caching |
| `test/recs.serve.js` | self-contained e2e serving test |
| `test/genres.live.js` | walks all 44 seeds (never completed) |
