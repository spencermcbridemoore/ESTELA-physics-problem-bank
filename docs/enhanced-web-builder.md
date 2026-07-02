# ESTELA Exam Builder — Enhanced web build

A second, fully self-contained web prototype that reproduces the desktop
(Rust/Tauri) app's "extra" exporters **entirely in the browser** — no Rust, no
Tauri, no install. It does **not** touch the existing web app
(`frontend/index.html`, `docs/standalone.html`) or the Tauri app; those keep
working unchanged.

## Files

| File | Purpose |
|------|---------|
| `frontend/exam-export-plus.js` | Browser ports of the desktop-only exporters (LaTeX `.tex`, bundle `.zip`, Word `.doc` beta, GitHub fetch). Reuses `EstelaBankSource` for bank data + figure bytes and `EstelaExamExport` for HTML preview. |
| `frontend/enhanced.html` | Copy of `index.html` that surfaces the new exporters in the sidebar **for the plain web build** (not gated behind `window.__TAURI__`). Keeps browse/filter/search/cart/versions/HTML-preview/per-bank QTI/YAML viewer, plus the mobile drawer. |
| `docs/standalone-enhanced.html` | Optional single-file offline build (banks embedded as base64 zip). |

## Build the offline single-file version

```sh
python scripts/build_standalone_html.py \
  --template frontend/enhanced.html \
  --output   docs/standalone-enhanced.html \
  --label    "PHY I Mechanics (enhanced)"
```

The build script inlines `exam-export-plus.js` only when the template references
it, so the default `index.html` → `docs/standalone.html` build is unaffected.

## What was ported (mirrors `src-tauri/src/main.rs`, then improves)

- **LaTeX `.tex` exam + key** — `build_exam_latex`, `build_key_latex`,
  `q_to_latex`, `html2tex`, `latex_to_html`, `tol_str`, `version_label`,
  `extract_mc_answers`, `strip_round_instruction`, `seeded_shuffle`,
  `answers_have_lock`, `get_qtype`. Downloaded as `exam_<ver>.tex` / `key_<ver>.tex`.
  - **`html2tex` escaping**: bare LaTeX specials `& % # _ ~ ^` (and `< >`) that
    occur **outside math** are escaped; `$…$`, `$$…$$`, `\(…\)`, `\[…\]` spans
    are copied through verbatim so real math is untouched; an unmatched `$` is
    escaped to `\$`. The exam **title** is escaped with `latexEscapeText` before
    injection into `\bfseries` / `\section*{…}`.
- **Bundle `.zip`** — `export_exam_bundle`: N versions of every exam+key `.tex`
  plus the referenced figures, laid out as `Exams/`, `Keys/`, `Images/`, with
  `\graphicspath{{../Images/}}` and `\includegraphics{<basename>}` so paths
  resolve. Assembled with JSZip, one `<title>-exams.zip` download.
- **Word `.docx`** — **beta**. The desktop path shells out to a bundled pandoc
  (LaTeX → OMML). A browser tab can't, so this emits a Word-openable HTML `.doc`
  with math rendered to **MathML** via KaTeX. Labelled "beta — math fidelity
  limited" in the UI and code.
- **Get Problem Banks (GitHub)** — `fetch_remote_courses` / `download_courses`.
  Reads the git-**trees** API once, then pulls files from
  `raw.githubusercontent.com` (permissive CORS). "Download" loads the fetched
  banks in as the active source (a `GitHubSource`, reusing browse/cart/preview/
  export), and optionally offers a `.zip` or — in Chromium — a real folder via
  the File System Access API. Non-array API responses (rate limit / error object)
  surface a clear message; an optional token raises the 60/hr anonymous limit.

## Verified

The pure-logic exporters are covered by an in-file `runSelfTests()` (23 checks)
plus independent Node + `pdflatex` + live-API checks:

- **Self-tests (23):**
  `node -e "require('./frontend/exam-export-plus.js'); console.log(EstelaExamExportPlus.runSelfTests())"`
  → `23/23`. Covers `html2tex`/`latexEscapeText` escaping (`& % # _ ~ ^` outside
  math; `$…$`/`$$…$$`/`\(…\)`/`\[…\]` passed through verbatim; a stray `$`→`\$`;
  an unmatched `$$`→`\$\$`), `buildExamLatex`/`buildKeyLatex` (title escaping,
  `\graphicspath{{../Images/}}`, `\includegraphics` basename, numerical
  Round-strip + work prompt, `\pm …\%` key tolerance, locked-MC letters) and the
  GitHub 403/404 messages. They also pass **in-browser** (run from the built
  standalone's console).
- **Node harness against the real `PHY I Mechanics` banks:** loads a bank via
  `bank-source.js`, then checks `.tex` (prose specials escaped, math intact), the
  bundle `.zip` (`Exams/`/`Keys/`/`Images/` layout, `\graphicspath{{../Images/}}`,
  and copied image bytes that byte-match the source figures) and the `.doc` (real
  KaTeX MathML + an embedded figure; beta banner present).
- **`pdflatex` gold standard:** the generated `exam_A.tex` + `key_A.tex` (real
  banks plus a specials-heavy question) compile cleanly under `texlive/texlive`;
  the extracted PDF text literally contains `50%`, `salt & water` and `#1` — so
  those specials render as characters, not commands/comments — with math intact.
- **GitHub fetch, live:** against the real repo the `GitHubSource` lists the
  course, scans the banks, loads a bank and resolves a `figure_folder/…` figure
  over the network; a nonexistent repo yields a clear `HTTP 404` message.
- **In-browser smoke (built `standalone-enhanced.html`):** boots with no console
  errors; banks load from the embedded zip; the `.tex`/`.zip`/`.doc` buttons each
  produce a valid download; the mobile drawer opens/closes at 375 px.

Not independently verified: **Word round-trip fidelity of the beta `.doc`** — the
emitted file contains MathML + figures, but how faithfully any given Word version
imports them is untested (see Known gaps).

## Known gaps (cannot be fully reproduced in-browser, or shared with the desktop)

- **Perfect `.docx` math** — no pandoc in the browser; MathML import into Word is
  close but not byte-identical to the desktop OMML, and embedded base64 figures
  may not survive every Word version.
- **Colliding figure basenames in a multi-bank bundle** — the bundle copies
  figures into one `Images/` folder keyed by basename, and `\includegraphics`
  references that basename, so if two carted banks each reference a figure with
  the **same filename** (e.g. `q-1.png`) only one is written and the other exam
  renders the wrong image. This mirrors the desktop `export_exam_bundle`
  (`src-tauri/src/main.rs`) exactly; a proper fix namespaces bundled images per
  bank in **both** apps so they stay in parity.
- **Writing to an arbitrary local folder** — a tab can only download files, or
  use the File System Access API (Chromium) when the user grants a folder;
  otherwise the fetch is delivered as one `.zip`.
- **GitHub zipball CORS** — `codeload.github.com` (where `/archive` and the API
  zipball redirect) doesn't reliably send CORS headers, so the repo zip is not
  streamed; individual files are fetched from `raw.githubusercontent.com` instead.
