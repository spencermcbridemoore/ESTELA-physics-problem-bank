#!/usr/bin/env python3
"""Conformance smoke test for "ESTELA Bank Service Protocol v1".

Verifies that a running bank service satisfies the v1 contract. Dependency-light:
uses only the standard library for HTTP + zip checks. If PyYAML is installed it
additionally verifies the reference bank parses and renders 3 categorization
groups; otherwise that deeper check is skipped with a note.

Usage:
    python smoke_test.py [--base http://localhost:8787] [--refresh-token TOKEN]

Exit code 0 = all required checks passed; 1 = one or more failed.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.parse
import urllib.request
import zipfile

# The reference bank the protocol pins its conformance to (see CHECKLIST.md).
ANCHOR_BANK = "PHY I Mechanics/6_Conservation of ME/PHY1-CME-MECC-10082025/PHY1-CME-MECC-10082025.yaml"
ANCHOR_DIR = ANCHOR_BANK.rsplit("/", 1)[0] + "/"
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    global _passed, _failed
    mark = "PASS" if ok else "FAIL"
    line = f"[{mark}] {name}"
    if detail:
        line += f" - {detail}"
    print(line)
    if ok:
        _passed += 1
    else:
        _failed += 1
    return ok


def warn(name: str, detail: str = "") -> None:
    print(f"[SKIP] {name}" + (f" - {detail}" if detail else ""))


def http_get(base: str, path: str, query: dict | None = None):
    url = base.rstrip("/") + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"Accept": "*/*"})
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status, dict(resp.getheaders()), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def http_post(base: str, path: str, headers: dict | None = None):
    url = base.rstrip("/") + path
    req = urllib.request.Request(url, method="POST", headers=headers or {})
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        return resp.status, dict(resp.getheaders()), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8787")
    ap.add_argument("--refresh-token", default="")
    ap.add_argument("--test-refresh", action="store_true", help="also exercise POST /refresh")
    args = ap.parse_args()
    base = args.base

    print(f"ESTELA Bank Service conformance - target {base}\n")

    # 1. /version returns the protocol id + a commit SHA.
    status, _, body = http_get(base, "/version")
    version = {}
    ok = status == 200
    if ok:
        try:
            version = json.loads(body)
        except Exception:
            ok = False
    sha = str(version.get("sha", ""))
    check("GET /version -> 200 with protocol + sha",
          ok and version.get("protocol") == "estela-bank-service/v1" and len(sha) >= 7,
          f"protocol={version.get('protocol')} sha={sha[:12]}")

    # 2. /tree returns a recursive listing incl. yaml, figures, and QTI zips.
    status, _, body = http_get(base, "/tree")
    files: list[str] = []
    if status == 200:
        try:
            files = json.loads(body).get("files", [])
        except Exception:
            pass
    fileset = set(files)
    check("GET /tree -> 200 non-empty listing", status == 200 and len(files) > 0, f"{len(files)} files")
    check("/tree includes bank .yaml files", any(f.endswith((".yaml", ".yml")) for f in files))
    check("/tree includes the anchor bank", ANCHOR_BANK in fileset, ANCHOR_BANK)
    anchor_zips = [f for f in files if f.startswith(ANCHOR_DIR) and f.lower().endswith(".zip")
                   and "/" not in f[len(ANCHOR_DIR):]]
    check("/tree includes the anchor's QTI zip", len(anchor_zips) > 0, ", ".join(anchor_zips) or "none")
    check("/tree includes at least one figure/image", any(f.lower().endswith(IMAGE_EXTS) for f in files))

    # 3. /file returns correct bytes + Content-Type for yaml.
    status, headers, body = http_get(base, "/file", {"path": ANCHOR_BANK})
    ctype = headers.get("Content-Type", headers.get("content-type", ""))
    yaml_text = body.decode("utf-8", "replace")
    check("GET /file (yaml) -> 200 text/yaml",
          status == 200 and "yaml" in ctype.lower(), f"status={status} type={ctype}")
    check("/file (yaml) body looks like a bank", "questions:" in yaml_text and "categorization" in yaml_text)

    # 3b. /file for the QTI zip ->application/zip and contains imsmanifest.xml.
    if anchor_zips:
        status, headers, zbody = http_get(base, "/file", {"path": anchor_zips[0]})
        ctype = headers.get("Content-Type", headers.get("content-type", ""))
        has_manifest = False
        qti_bits = ""
        if status == 200:
            try:
                zf = zipfile.ZipFile(io.BytesIO(zbody))
                names = zf.namelist()
                has_manifest = "imsmanifest.xml" in names
                qti_bits = f"{len(names)} entries"
            except Exception as e:
                qti_bits = f"unzip error: {e}"
        check("GET /file (zip) -> 200 application/zip", status == 200 and "zip" in ctype.lower(),
              f"status={status} type={ctype}")
        check("QTI zip contains imsmanifest.xml", has_manifest, qti_bits)
    else:
        warn("QTI zip checks", "no anchor zip in /tree")

    # 4. /file blocks path traversal.
    status, _, _ = http_get(base, "/file", {"path": "../README.md"})
    check("/file blocks '../' traversal", status in (400, 403, 404), f"status={status}")
    status2, _, _ = http_get(base, "/file", {"path": "../../../../etc/passwd"})
    check("/file blocks deep traversal", status2 in (400, 403, 404), f"status={status2}")

    # 5. (optional) reference bank renders 3 categorization groups.
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(yaml_text)
        qs = data.get("questions", []) if isinstance(data, dict) else []
        cat = next((q["categorization"] for q in qs if isinstance(q, dict) and "categorization" in q), None)
        # Mirror buildCategorizationGroups (frontend/bank-source.js): unwrap each
        # entry.category, require an object, and add a distractors group only when
        # the distractors list is non-empty — so this count matches what renders.
        groups = 0
        if cat:
            for entry in (cat.get("categories") or []):
                c = entry
                if isinstance(c, dict) and isinstance(c.get("category"), dict):
                    c = c["category"]
                if isinstance(c, dict):
                    groups += 1
            distractors = cat.get("distractors") or []
            if isinstance(distractors, list) and len(distractors) > 0:
                groups += 1
        check("anchor bank renders 3 categorization groups", groups == 3, f"groups={groups}")
    except ImportError:
        warn("categorization-groups check", "PyYAML not installed (pip install pyyaml) - verify in browser")

    # 6. (optional) POST /refresh picks up the current upstream head.
    if args.test_refresh:
        hdrs = {"X-Refresh-Token": args.refresh_token} if args.refresh_token else {}
        status, _, body = http_post(base, "/refresh", hdrs)
        payload = {}
        if status == 200:
            try:
                payload = json.loads(body)
            except Exception:
                payload = {}
        new_sha = str(payload.get("sha", ""))
        check("POST /refresh -> 200 with sha", status == 200 and len(new_sha) >= 7, f"status={status} sha={new_sha[:12]}")
        check("/refresh reports a 'changed' flag", isinstance(payload.get("changed"), bool), f"changed={payload.get('changed')}")
    else:
        warn("POST /refresh", "pass --test-refresh to exercise")

    print(f"\n{_passed} passed, {_failed} failed")
    return 1 if _failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
