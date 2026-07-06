# Conformance Checklist — ESTELA Bank Service Protocol v1

A consumer's server satisfies **v1** if every box below is checked. The
automated `smoke_test.py` covers the HTTP-contract rows; the browser rows are
verified by loading the frontend against the service (see
[the protocol doc](../../docs/estela-bank-service-protocol-v1.md)).

**Anchor bank:** `PHY I Mechanics/6_Conservation of ME/PHY1-CME-MECC-10082025` —
its first categorization question has 3 categories and no distractors, so it must
render exactly **3 categorization groups**. Its `import.zip` is the Canvas QTI
package.

## Automated (run `python smoke_test.py --base <url> [--test-refresh]`)

- [ ] `GET /version` returns `protocol: "estela-bank-service/v1"` and a commit `sha`.
- [ ] `GET /tree` returns a recursive listing including bank `.yaml`/`.yml`, figures, and QTI `.zip`s.
- [ ] `GET /file` returns correct bytes + `Content-Type` for `.yaml` (`text/yaml`).
- [ ] `GET /file` returns `application/zip` for the anchor's `import.zip`, and it contains `imsmanifest.xml`.
- [ ] `GET /file` blocks path traversal (`../…` → 4xx, never serves outside the clone).
- [ ] `POST /refresh` returns a `sha` and a boolean `changed` flag. (Verifying it actually *picks up* a new upstream commit — `changed: true` and a new bank appearing — is a manual step: commit upstream, then refresh.)
- [ ] (with PyYAML) the anchor bank parses and yields 3 categorization groups.

## Browser (load `frontend/` with `window.__ESTELA_REMOTE__ = { apiBase }`)

- [ ] Banks list populates; draft/deprecated banks and `SKIP_DIRS`/`SKIP_COURSES` are excluded from the scan.
- [ ] Anchor bank **PHY1-CME-MECC-10082025** previews and shows **3 categorization groups**.
- [ ] Its Canvas QTI package downloads (`⬇ QTI`) as `<bank_id>-canvas-qti.zip`.
- [ ] At least one figure resolves and renders in a preview.
- [ ] The YAML / prompts modal (`📄 YAML`) shows the generation prompts for a bank.
- [ ] Building a preview exam works (Print → Save as PDF path in a plain browser).

## Notes

- Draft/deprecated exclusion and `SKIP_*` filtering are **client-side scan** behavior
  (`scanFlatPaths` in `frontend/bank-source.js`). The server stays dumb and returns the
  full tracked-file list from `/tree`; the adapter filters. This is by design — the bank
  model is never parsed server-side.
- `smoke_test.py` uses only the standard library; the categorization-groups check
  additionally uses PyYAML if present (`pip install pyyaml`), otherwise it is skipped.
