#!/usr/bin/env python3
"""ESTELA Bank Service — reference implementation of "ESTELA Bank Service Protocol v1".

A deliberately *thin* HTTP service that fronts a read-only clone of the upstream
problem-bank repo. It does NOT parse YAML or understand the bank model — it only
does git cache/refresh + directory listing + raw file bytes. All bank parsing
happens client-side in `frontend/bank-source.js` (the RemoteSource adapter),
which is the whole point: the bank model is never copied a third time.

Endpoints (see docs/estela-bank-service-protocol-v1.md):
    GET  /version            -> { protocol, repo, ref, sha, fetchedAt }
    GET  /tree               -> { protocol, ref, sha, fetchedAt, files: [ "Course/Topic/Bank/Bank.yaml", ... ] }
    GET  /file?path=<rel>    -> raw bytes (+ correct Content-Type)
    POST /refresh            -> { protocol, ref, sha, fetchedAt, changed }   (guarded; git fetch + reset, never pushes)
    GET  /health             -> { ok: true, protocol }

Upstream is cloned/fetched only — this service NEVER writes to the upstream repo.

Configuration (environment variables, all optional):
    ESTELA_UPSTREAM_REPO   default "Zhongzhou/ESTELA-physics-problem-bank"
    ESTELA_BRANCH          default "main"
    ESTELA_CACHE_DIR       default "<this dir>/.cache/estela-bank"
    ESTELA_TTL_SECONDS     default "300"  (lazy pull on read when cache older than this; 0 disables)
    ESTELA_CORS_ORIGINS    default "*"    (comma-separated; use explicit origins in production)
    ESTELA_REFRESH_TOKEN   default ""     (if set, POST /refresh requires X-Refresh-Token to match)
    ESTELA_GIT_DEPTH       default "1"    (shallow clone depth; "0" for a full clone)
    ESTELA_GIT_TIMEOUT     default "120"  (per-git-command timeout in seconds)

Run:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8787
"""

from __future__ import annotations

import hmac
import os
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

PROTOCOL = "estela-bank-service/v1"

# ── Config ────────────────────────────────────────────────────────────────────

UPSTREAM_REPO = os.environ.get("ESTELA_UPSTREAM_REPO", "Zhongzhou/ESTELA-physics-problem-bank")
BRANCH = os.environ.get("ESTELA_BRANCH", "main")
CACHE_DIR = Path(
    os.environ.get("ESTELA_CACHE_DIR", str(Path(__file__).resolve().parent / ".cache" / "estela-bank"))
).resolve()
TTL_SECONDS = int(os.environ.get("ESTELA_TTL_SECONDS", "300"))
CORS_ORIGINS = [o.strip() for o in os.environ.get("ESTELA_CORS_ORIGINS", "*").split(",") if o.strip()]
REFRESH_TOKEN = os.environ.get("ESTELA_REFRESH_TOKEN", "")
GIT_DEPTH = int(os.environ.get("ESTELA_GIT_DEPTH", "1"))
GIT_TIMEOUT = int(os.environ.get("ESTELA_GIT_TIMEOUT", "120"))

REPO_URL = f"https://github.com/{UPSTREAM_REPO}.git"

# Never block on an interactive credential/auth prompt — fail fast instead.
GIT_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

CONTENT_TYPES = {
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".zip": "application/zip",
    ".pdf": "application/pdf",
}


class CacheError(RuntimeError):
    """Raised when the git cache can't be read/refreshed. Rendered as a clean 503."""


# ── Git cache (fetch-only; never pushes upstream) ──────────────────────────────

_lock = threading.RLock()
_last_fetch_epoch = 0.0


def _git(*args: str, cwd: Path | None = None) -> str:
    """Run a git command, returning stripped stdout. Raises CacheError on failure.

    Never surfaces raw git stderr to callers (it can carry the remote URL); the
    real error is logged server-side and callers get a generic message.
    """
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            env=GIT_ENV,
            timeout=GIT_TIMEOUT,
        )
    except FileNotFoundError as e:
        raise CacheError("git executable not found on PATH") from e
    except subprocess.TimeoutExpired as e:
        raise CacheError(f"git {args[0] if args else ''} timed out after {GIT_TIMEOUT}s") from e
    if proc.returncode != 0:
        print(
            f"[estela-bank-service] git {' '.join(args)} failed (exit {proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()}",
            file=sys.stderr,
        )
        raise CacheError(f"git {args[0] if args else ''} failed (exit {proc.returncode})")
    return proc.stdout.strip()


def _is_clone() -> bool:
    return (CACHE_DIR / ".git").is_dir()


def ensure_clone() -> None:
    """Clone upstream on first use. Fetch-only; never writes to the remote."""
    global _last_fetch_epoch
    with _lock:
        if _is_clone():
            return
        CACHE_DIR.parent.mkdir(parents=True, exist_ok=True)
        args = ["clone", "--branch", BRANCH, "--single-branch"]
        if GIT_DEPTH > 0:
            args += ["--depth", str(GIT_DEPTH)]
        args += [REPO_URL, str(CACHE_DIR)]
        _git(*args)
        _last_fetch_epoch = time.time()


def refresh(force: bool = True) -> bool:
    """Fetch upstream and hard-reset the working tree to it. Returns True if the SHA changed.

    Uses fetch + reset --hard (not pull) so it is robust on shallow clones and
    upstream force-pushes. This clone is read-only for serving; we never make
    local commits, so a hard reset is always safe here. Double-checked under the
    lock so queued callers don't redundantly re-fetch a tree just refreshed.
    """
    global _last_fetch_epoch
    ensure_clone()  # acquires _lock (reentrant) then releases before the block below
    with _lock:
        if not force and TTL_SECONDS > 0 and (time.time() - _last_fetch_epoch) <= TTL_SECONDS:
            return False  # another caller already refreshed within the TTL window
        before = current_sha()
        fetch_args = ["fetch", "origin", BRANCH]
        if GIT_DEPTH > 0:
            fetch_args += ["--depth", str(GIT_DEPTH)]
        _git(*fetch_args, cwd=CACHE_DIR)
        _git("reset", "--hard", f"origin/{BRANCH}", cwd=CACHE_DIR)
        _last_fetch_epoch = time.time()
        return current_sha() != before


def maybe_refresh() -> None:
    """Lazy TTL pull: refresh if the cache is older than TTL_SECONDS."""
    if TTL_SECONDS <= 0:
        return
    if time.time() - _last_fetch_epoch <= TTL_SECONDS:
        return
    try:
        refresh(force=False)  # re-checks the TTL under the lock (double-checked)
    except Exception:
        # serving stale-but-present cache beats a hard failure on transient errors
        pass


def current_sha() -> str:
    return _git("rev-parse", "HEAD", cwd=CACHE_DIR)


def fetched_at_iso() -> str:
    ts = _last_fetch_epoch or time.time()
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def list_files() -> list[str]:
    """Tracked files, repo-relative, POSIX separators. Respects upstream .gitignore."""
    out = _git("ls-files", cwd=CACHE_DIR)
    return [line for line in out.splitlines() if line]


def safe_resolve(rel: str) -> Path:
    """Resolve a request path strictly within the cache root (blocks traversal)."""
    rel = rel.replace("\\", "/").lstrip("/")
    root = CACHE_DIR.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="path escapes repository root")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return target


def content_type_for(path: Path) -> str:
    return CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _safe_sha() -> str:
    try:
        return current_sha()
    except Exception:
        return ""


# ── App ────────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Clone eagerly so the first client request isn't slow. Failures here are
    # logged but non-fatal — endpoints call ensure_clone() lazily and retry.
    try:
        ensure_clone()
    except Exception as exc:
        print(f"[estela-bank-service] startup clone deferred: {exc}", file=sys.stderr)
    yield


app = FastAPI(title="ESTELA Bank Service", version=PROTOCOL, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(CacheError)
async def _cache_error_handler(request: Request, exc: CacheError) -> JSONResponse:
    # git/cache failure: already logged in _git; return a generic message (no stderr leak).
    return JSONResponse(status_code=503, content={"error": "bank cache unavailable", "protocol": PROTOCOL})


@app.get("/health")
def health() -> dict:
    return {"ok": True, "protocol": PROTOCOL}


@app.get("/version")
def version() -> dict:
    ensure_clone()
    maybe_refresh()
    return {
        "protocol": PROTOCOL,
        "repo": UPSTREAM_REPO,
        "ref": BRANCH,
        "sha": current_sha(),
        "fetchedAt": fetched_at_iso(),
    }


@app.get("/tree")
def tree() -> dict:
    ensure_clone()
    maybe_refresh()
    with _lock:  # snapshot the listing consistently with the sha reported alongside it
        return {
            "protocol": PROTOCOL,
            "ref": BRANCH,
            "sha": current_sha(),
            "fetchedAt": fetched_at_iso(),
            "files": list_files(),
        }


@app.get("/file")
def file(path: str = Query(..., description="repo-relative path")) -> Response:
    ensure_clone()
    # Read under _lock so a concurrent refresh (which resets the working tree
    # under the same lock) can't swap or partially-write the file mid-read. This
    # prevents torn reads / TOCTOU 500s. It does NOT give a scanning client full
    # cross-request snapshot isolation if a refresh commits a new sha between its
    # /tree and /file calls — freshness is TTL/refresh-driven, and the returned
    # X-Estela-Sha lets a client detect a mid-scan sha change if it cares.
    # NOTE: intentionally no maybe_refresh() here — a scan issues many /file
    # reads and TTL freshness is driven by /version + /tree.
    with _lock:
        target = safe_resolve(path)
        try:
            data = target.read_bytes()
        except OSError:
            raise HTTPException(status_code=404, detail="not found")
        media_type = content_type_for(target)
        sha = _safe_sha()
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "X-Estela-Sha": sha,
        },
    )


@app.post("/refresh")
def do_refresh(request: Request) -> JSONResponse:
    if REFRESH_TOKEN:
        supplied = request.headers.get("X-Refresh-Token", "")
        if not hmac.compare_digest(supplied, REFRESH_TOKEN):
            raise HTTPException(status_code=401, detail="invalid or missing X-Refresh-Token")
    changed = refresh(force=True)  # CacheError -> 503 via the exception handler
    return JSONResponse(
        {
            "protocol": PROTOCOL,
            "ref": BRANCH,
            "sha": current_sha(),
            "fetchedAt": fetched_at_iso(),
            "changed": changed,
        }
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", os.environ.get("ESTELA_PORT", "8787")))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
