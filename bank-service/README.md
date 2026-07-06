# ESTELA Bank Service

Reference implementation of the **[ESTELA Bank Service Protocol v1](../docs/estela-bank-service-protocol-v1.md)** —
a thin HTTP backend that lets any website serve the ESTELA exam maker by querying
problem-bank data **live** from a read-only clone of the upstream repo.

It is deliberately dumb: git cache/refresh + directory listing + raw file bytes.
It never parses YAML — all bank parsing happens client-side in the `RemoteSource`
adapter (`frontend/bank-source.js`). This keeps the bank model from being copied a
third time.

> **Live-serving path.** Separate from the frozen-snapshot path
> (`scripts/build_standalone_html.py` + `BundleSource`). Don't entangle them.

## Quickstart

```bash
cd bank-service
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8787
#   ...or: python app.py
```

On first start it clones `Zhongzhou/ESTELA-physics-problem-bank@main` into
`.cache/estela-bank/` (fetch-only; it never pushes upstream). Then:

```bash
curl http://localhost:8787/version
curl http://localhost:8787/tree | head
curl -X POST http://localhost:8787/refresh
```

## Serve the frontend against it

From the repo root, serve the static frontend and inject the adapter config:

```bash
python -m http.server 8080 --directory frontend
```

Then open a page that sets `window.__ESTELA_REMOTE__ = { apiBase: "http://localhost:8787/" }`
**before** `bank-source.js`. For local testing you can add that one `<script>` to a
copy of `frontend/index.html`; for production use the copy-paste embed snippet in
the [protocol doc](../docs/estela-bank-service-protocol-v1.md#5-embed-snippet).
Make sure `ESTELA_CORS_ORIGINS` allows the page's origin.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ESTELA_UPSTREAM_REPO` | `Zhongzhou/ESTELA-physics-problem-bank` | `owner/repo` to clone |
| `ESTELA_BRANCH` | `main` | branch to pin |
| `ESTELA_CACHE_DIR` | `bank-service/.cache/estela-bank` | on-disk clone location |
| `ESTELA_TTL_SECONDS` | `300` | lazy pull on read when cache older than this; `0` disables |
| `ESTELA_CORS_ORIGINS` | `*` | comma-separated allowed origins (set explicit origins in prod) |
| `ESTELA_REFRESH_TOKEN` | _(empty)_ | if set, `POST /refresh` requires a matching `X-Refresh-Token` header |
| `ESTELA_GIT_DEPTH` | `1` | shallow clone depth; `0` for a full clone |

Requires `git` on the host PATH.

## Conformance

```bash
python conformance/smoke_test.py --base http://localhost:8787 --test-refresh
```

See [conformance/CHECKLIST.md](conformance/CHECKLIST.md) for the full v1 checklist
(HTTP-contract rows are automated; browser rows are verified by loading the frontend).

## Deploying behind Azure Functions (documented, not built)

The app is a standard ASGI application (`app` in `app.py`), so it wraps into an
Azure Function without a rewrite. The adapter only knows `apiBase`, so nothing on
the frontend changes. Sketch:

1. Add `azure-functions` and an ASGI shim to `requirements.txt`.
2. Create an HTTP-triggered function with `route: "{*path}"` and forward to the app:

   ```python
   # function_app.py (sketch — not included in v1)
   import azure.functions as func
   from app import app as asgi_app

   app = func.AsgiFunctionApp(app=asgi_app, http_auth_level=func.AuthLevel.ANONYMOUS)
   ```

3. Point the cache dir at writable storage (e.g. a mounted share) and prefer
   `POST /refresh` (webhook or timer) over per-read TTL pulls on cold starts.

This keeps v1 a plain, transport-agnostic HTTP service while leaving the Azure
path a documented, low-friction follow-on.
