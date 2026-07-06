# ESTELA Bank Service Protocol — v1

**Protocol id:** `estela-bank-service/v1` (returned in every JSON payload as `protocol`).

A small, reusable integration surface that lets any website serve the ESTELA
exam/question maker by querying problem-bank data **live** from a read-only clone
of the upstream repo (`Zhongzhou/ESTELA-physics-problem-bank`, branch `main`).

The design in one line: **one browser adapter + one thin backend, with a stable
contract between them.** The backend is deliberately dumb — git cache/refresh +
directory listing + raw file bytes. It never parses YAML and never understands the
bank model. All parsing happens in the browser via the shared helpers in
`frontend/bank-source.js`, so the bank model is never copied a third time (it
already lives in `src-tauri/src/main.rs` and `frontend/bank-source.js`).

> This is the **live-serving** path. It is intentionally separate from the
> **frozen-snapshot** path (`scripts/build_standalone_html.py` + `BundleSource` +
> the Tauri Rust exports), which embeds banks into a single HTML file.

---

## 1. The two halves

| Half | What it is | Where |
|---|---|---|
| **Adapter** | `RemoteSource`, a `BankSource` implementation | `frontend/bank-source.js` |
| **Service** | Reference HTTP backend (FastAPI) | `bank-service/` |

The page selects `RemoteSource` when `window.__ESTELA_REMOTE__ = { apiBase }` is
present (see `autoSelectSource()`), exactly mirroring the `window.__ESTELA_BUNDLE__`
precedent used by `BundleSource`.

---

## 2. Endpoints

All responses include `"protocol": "estela-bank-service/v1"`.

### `GET /version`
```json
{ "protocol": "estela-bank-service/v1", "repo": "Zhongzhou/ESTELA-physics-problem-bank",
  "ref": "main", "sha": "<commit sha>", "fetchedAt": "2026-06-30T12:00:00Z" }
```
Clients cache-bust on `sha`: when it changes, re-fetch `/tree`.

### `GET /tree`
```json
{ "protocol": "estela-bank-service/v1", "ref": "main", "sha": "<commit sha>",
  "fetchedAt": "2026-06-30T12:00:00Z",
  "files": [ "PHY I Mechanics/6_Conservation of ME/PHY1-CME-MECC-10082025/PHY1-CME-MECC-10082025.yaml", "..." ] }
```
A recursive listing of **tracked** files (repo-relative, POSIX separators). This
is the flat path list the adapter groups into `course → topic → bank` — the same
shape `ZipSource` derives from a zip index.

### `GET /file?path=<repo-relative path>`
Raw bytes with a correct `Content-Type` (`.yaml/.yml`→`text/yaml`, images→`image/*`,
`.zip`→`application/zip`). **Must** reject path traversal — only files inside the
clone are served.

### `POST /refresh`
Fetch upstream and fast-forward the cache; returns the (possibly new) `sha` and
`"changed": <bool>`. **Fetch-only — never pushes upstream.** Guard with a token
(`X-Refresh-Token`) or network policy in production.

### `GET /health`
`{ "ok": true, "protocol": "estela-bank-service/v1" }`

**Not in v1:** no `/index` endpoint. Server-side pre-parsing of YAML meta would
reintroduce a second bank parser — the exact duplication this design avoids.
Revisit only as a measured performance fallback.

---

## 3. Adapter method ↔ endpoint map

`RemoteSource` implements the `BankSource` contract the UI calls. Each method
composes the dumb endpoints with the **shared, client-side** helpers
(`parseYaml`, `bankMeta`, `buildQuestionsFromData`, `buildCategorizationGroups`,
`verifyQtiZipBytes`, `qtiDownloadName`, `bytesToDataUrl`, …).

| Adapter method | Endpoint(s) used | Returns | Notes |
|---|---|---|---|
| `scan()` | `GET /version`, `GET /tree`, then `GET /file` per candidate `.yaml` | `{ data: { course: { topic: [ {path, meta, bankRef} ] } } }` | Grouping via shared `scanFlatPaths`; filters `draft`/`deprecated`; honors `SKIP_DIRS`/`SKIP_COURSES`; sets `meta.has_qti` from tree membership |
| `loadBank(ref)` | `GET /file` (bank YAML) | `{ meta, rawData, questions, bankRef }` | YAML parsed client-side; figures resolved during question build |
| `loadBankText(ref)` | `GET /file` (bank YAML) | raw YAML string | feeds the YAML/prompts modal |
| `getQtiPackage(ref)` | `GET /tree` + `GET /file` (zip) | `{ bytes, filename }` or `null` | picks the best `.zip` next to the bank via `qtiZipPreference`; verifies `imsmanifest.xml`; names `<bank_id>-canvas-qti.zip` |
| `resolveFigure(ref, qdata, bankRef)` | `GET /tree` (lookup) + `GET /file` (image) | data URL or `null` | resolves candidates against the fetched tree — **lookup, not network probing** |
| `getDisplayPath()` / `findBankRef(repoData, path)` | — | — | sidebar label + cart restore |

**Resolution insight:** because `/tree` returns the full file list, the adapter
resolves figures and QTI zips by checking the already-fetched tree, then issuing a
single `GET /file` — it never guesses candidate URLs against the network.

---

## 4. Versioning & pinning

- The protocol version is signaled by the `protocol` string in every payload.
- Breaking changes bump to `estela-bank-service/v2` (new string); v1 payloads stay valid.
- Consumers (e.g. narvi) pin to a **git tag or commit SHA** of this fork so the
  adapter and the service endpoints can't silently drift apart.

---

## 5. Embed snippet

*"Drop these files + this script and you're serving it."*

Serve the three static frontend files and point the adapter at your running
service. The `<script>` must come **before** `bank-source.js`.

```html
<!-- ...existing <head> assets: fonts, KaTeX, js-yaml, jszip... -->
<script>
  // Point at your ESTELA Bank Service (see bank-service/README.md to run one).
  window.__ESTELA_REMOTE__ = { apiBase: "https://your-bank-service.example.com/" };
</script>
<script src="bank-source.js"></script>
<script src="exam-export.js"></script>
```

Files to serve (from `frontend/`): `index.html`, `bank-source.js`, `exam-export.js`.
Also load the same CDN libs `index.html` uses (js-yaml, JSZip, KaTeX). No build
step required.

---

## 6. Out of scope for v1

- Server-side `.tex`/`.docx` export (browsers use the print-to-PDF path).
- Auth/accounts, write-back to any repo, multi-tenant config.
- The standalone / `BundleSource` snapshot path (kept separate, untouched).
- A server-side `/index` YAML pre-parse (would duplicate the bank model).
