/**
 * EstelaExamExportPlus — browser ports of the desktop (Tauri) "extra" exporters.
 * =============================================================================
 *
 * The web build (frontend/index.html, docs/standalone.html) only offered HTML
 * preview + per-bank QTI download. Everything else — LaTeX .tex export, the
 * Exams/Keys/Images bundle, Word .docx, and "Get Problem Banks" from GitHub —
 * lived in Rust behind window.__TAURI__ (src-tauri/src/main.rs). This module
 * re-implements those in pure client-side JS so frontend/enhanced.html can offer
 * them to the plain web build too (no Rust, no Tauri, no install).
 *
 * It reuses the existing EstelaBankSource adapters for bank data + figure bytes
 * and EstelaExamExport for HTML preview. It touches neither bank-source.js nor
 * exam-export.js, so the current apps keep working unchanged.
 *
 * Small helpers (getQtype / extractMcAnswers / latexToHtml / versionLabel /
 * seededShuffle / answersHaveLock) are pulled from the page globals when present
 * and fall back to local copies otherwise — so the pure-LaTeX functions also run
 * under Node for the self-tests at the bottom (EstelaExamExportPlus.runSelfTests).
 *
 * ── html2tex fix (vs the original desktop bug) ───────────────────────────────
 * The FIRST desktop html2tex only escaped bare `<` and `>`; a literal `&`, `%`,
 * `#`, `_`, `~` or `^` sitting in prose (e.g. "50% ... salt & water", "x_0")
 * flowed into the .tex verbatim and broke LaTeX compilation (or silently ate the
 * rest of a line). This port escapes ALL of & % # _ ~ ^ (and < >) that occur
 * OUTSIDE math. Math spans — $…$, $$…$$, \(…\) and \[…\] — are located by their
 * matching closer and copied through verbatim, so real math (including the
 * $^{…}$ / $_{…}$ produced from <sup>/<sub>) is left untouched. An unmatched `$`
 * is treated as a literal dollar and escaped to `\$`. The exam title is escaped
 * separately with latexEscapeText() before it is injected into \bfseries /
 * \section*{…}. (The current main.rs already carries this same fix; this is the
 * faithful JS port of the fixed behaviour.)
 *
 * ── Known gaps that CANNOT be fully reproduced in-browser ────────────────────
 *  • .docx math fidelity: the desktop path shells out to a bundled pandoc
 *    (LaTeX → OMML native Word equations). A browser tab can't run pandoc, so
 *    buildExamDoc/buildKeyDoc emit a Word-openable HTML .doc with math converted
 *    to MathML via KaTeX. Word imports MathML but the result is not byte-identical
 *    to pandoc's OMML, and embedded base64 figures may not survive every Word
 *    version. This exporter is labelled "beta — math fidelity limited".
 *  • Writing to an arbitrary local folder: a tab can only download files (or, in
 *    Chromium, use the File System Access API when the user grants a folder).
 *    The desktop app writes straight to a chosen directory; the browser bundle
 *    is delivered as one .zip instead.
 *  • GitHub zipball CORS: codeload.github.com (where /archive and api zipball
 *    redirect) does not reliably send CORS headers, so we do NOT stream the repo
 *    zip. Instead we read the git *trees* API (one call) and pull individual
 *    files from raw.githubusercontent.com (which does send `*` CORS). Anonymous
 *    GitHub API use is capped at 60 req/hr; an optional token raises it.
 */
(function (global) {
  'use strict';

  const BS = global.EstelaBankSource || {};
  const EX = global.EstelaExamExport || {};

  // ── Constants (mirror main.rs / bank-source.js) ────────────────────────────
  const QTYPES = [
    'numerical', 'multiple_choice', 'true_false', 'multiple_answers',
    'essay', 'categorization', 'ordering', 'fill_in_multiple_blanks',
    'formula', 'file_upload', 'hot_spot',
  ];
  const SKIP_DIRS = BS.SKIP_DIRS || [
    'Old', 'old', 'Archive', 'archive', 'Older versions', 'Older Versions',
    'Drafts', 'drafts', 'Temporary', 'temporary', 'venv', '__pycache__',
    '.git', 'Scripts', 'scripts', 'Figure Creation', 'figure_creation',
  ];
  const SKIP_COURSES = BS.SKIP_COURSES || [
    'venv', 'Templates', 'Bank Statistics', '.git',
    'frontend', 'src-tauri', 'src', 'node_modules', '.github',
    'target', 'dist', 'build',
  ];
  const DEFAULT_REPO = 'Zhongzhou/ESTELA-physics-problem-bank';

  // ── Helper resolution: prefer page globals, else local fallbacks ───────────
  const getQtype = BS.getQtype || function (q) {
    if (q && typeof q === 'object' && !Array.isArray(q)) {
      for (const k of QTYPES) {
        if (Object.prototype.hasOwnProperty.call(q, k)) return k;
      }
      const keys = Object.keys(q);
      if (keys.length) return keys[0];
    }
    return 'unknown';
  };

  const extractMcAnswers = BS.extractMcAnswers || function (answers) {
    const result = [];
    if (!Array.isArray(answers)) return result;
    for (let j = 0; j < answers.length; j++) {
      const a = answers[j];
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        result.push([j, typeof a === 'string' ? a : String(a ?? ''), false]);
        continue;
      }
      if (a.answer && typeof a.answer === 'object') {
        result.push([j, a.answer.text || '', !!a.answer.correct]);
      } else if ('text' in a) {
        result.push([j, a.text || '', !!a.correct]);
      } else {
        result.push([j, JSON.stringify(a), false]);
      }
    }
    return result;
  };

  const latexToHtml = BS.latexToHtml || function (text) {
    if (!text) return '';
    let result = String(text);
    result = result.replace(/<latex>\s*\n([\s\S]*?)\n\s*<\/latex>/g, '$$\n$1\n$$');
    result = result.replace(/<latex>([\s\S]*?)<\/latex>/g, '$$$1$');
    result = result.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
    return result;
  };

  const typeLabel = BS.typeLabel || function (qtype) {
    const map = {
      numerical: 'Numerical', multiple_choice: 'Multiple Choice',
      multiple_answers: 'Multiple Answer', true_false: 'True / False',
      essay: 'Essay', formula: 'Formula', categorization: 'Categorization',
      fill_in_multiple_blanks: 'Fill-in-the-Blank', ordering: 'Ordering',
      hot_spot: 'Hot Spot',
    };
    return map[qtype] || qtype;
  };

  const versionLabel = EX.versionLabel || function (v) {
    const n = Number(v);
    if (n >= 1 && n <= 26) return String.fromCharCode(64 + n);
    return String(n);
  };

  const answersHaveLock = EX.answersHaveLock || function (answers) {
    if (!Array.isArray(answers)) return false;
    return answers.some((a) => a?.answer?.lock === true);
  };

  const seededShuffle = EX.seededShuffle || function (items, seed) {
    const n = items.length;
    if (n <= 1) return;
    let rng = BigInt(seed);
    const mask = (1n << 64n) - 1n;
    const mul = 6364136223846793005n;
    const add = 1442695040888963407n;
    for (let i = n - 1; i >= 1; i--) {
      rng = (rng * mul + add) & mask;
      const j = Number(rng >> 33n) % (i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
  };

  // Seed matches Rust build_exam_latex / build_key_latex: version*10000 + qNum,
  // where qNum is the 1-based running question number across the whole exam.
  // (Note: this deliberately differs from the HTML preview, which seeds from a
  // 0-based counter — mirroring the same difference in the desktop app, so the
  // exam .tex and key .tex agree with each other.)
  function seedFor(version, qNum) { return Number(version) * 10000 + qNum; }

  function basename(p) {
    return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A) LaTeX helpers — faithful ports of main.rs
  // ══════════════════════════════════════════════════════════════════════════

  /** Index of the second char of the first `a`+`b` pair at/after `start`, else -1. */
  function findPair(chars, start, a, b) {
    let j = start;
    while (j + 1 < chars.length) {
      if (chars[j] === a && chars[j + 1] === b) return j + 1;
      j += 1;
    }
    return -1;
  }

  /** Index of the first `target` char at/after `start`, else -1. */
  function findChar(chars, start, target) {
    let j = start;
    while (j < chars.length) {
      if (chars[j] === target) return j;
      j += 1;
    }
    return -1;
  }

  /**
   * Escape every LaTeX special for a PLAIN-TEXT field (no math expected), e.g.
   * the exam title injected into \section*{} / \bfseries. Port of latex_escape_text.
   */
  function latexEscapeText(s) {
    let out = '';
    for (const c of String(s == null ? '' : s)) {
      switch (c) {
        case '\\': out += '\\textbackslash{}'; break;
        case '&': out += '\\&'; break;
        case '%': out += '\\%'; break;
        case '$': out += '\\$'; break;
        case '#': out += '\\#'; break;
        case '_': out += '\\_'; break;
        case '{': out += '\\{'; break;
        case '}': out += '\\}'; break;
        case '~': out += '\\textasciitilde{}'; break;
        case '^': out += '\\textasciicircum{}'; break;
        // < and > are not compilation-breaking in text mode (Rust leaves them),
        // but they typeset as the wrong glyph — escape them here as a small
        // improvement, since a title is plain text with no math.
        case '<': out += '\\textless{}'; break;
        case '>': out += '\\textgreater{}'; break;
        default: out += c;
      }
    }
    return out;
  }

  /**
   * Convert HTML-ish question text to LaTeX. Port of html2tex (main.rs:93) —
   * including the fix that escapes bare specials outside math (see file header).
   */
  function html2tex(text) {
    if (!text) return '';
    let result = String(text);
    // Block latex: <latex>\n...\n</latex> → \[\n...\n\]
    result = result.replace(/<latex>\s*\n([\s\S]*?)\n\s*<\/latex>/g, (_m, g1) => `\\[\n${g1}\n\\]`);
    // Inline latex: <latex>...</latex> → \(...\)
    result = result.replace(/<latex>([\s\S]*?)<\/latex>/g, (_m, g1) => `\\(${g1}\\)`);
    // <strong>/<b> → \textbf{...}
    result = result.replace(/<strong>([\s\S]*?)<\/strong>/g, (_m, g1) => `\\textbf{${g1}}`);
    result = result.replace(/<b>([\s\S]*?)<\/b>/g, (_m, g1) => `\\textbf{${g1}}`);
    // <em> → \textit{...}
    result = result.replace(/<em>([\s\S]*?)<\/em>/g, (_m, g1) => `\\textit{${g1}}`);
    // <sup> → $^{...}$ , <sub> → $_{...}$
    result = result.replace(/<sup>([\s\S]*?)<\/sup>/g, (_m, g1) => `$^{${g1}}$`);
    result = result.replace(/<sub>([\s\S]*?)<\/sub>/g, (_m, g1) => `$_{${g1}}$`);
    // strip remaining HTML tags
    result = result.replace(/<[^>]+>/g, '').trim();

    // Escape LaTeX text specials outside math; copy math spans / commands verbatim.
    const chars = Array.from(result);
    const n = chars.length;
    let out = '';
    let i = 0;
    while (i < n) {
      const c = chars[i];

      // \( … \)  and  \[ … \]  — copy the whole math span verbatim.
      if (c === '\\' && i + 1 < n && (chars[i + 1] === '(' || chars[i + 1] === '[')) {
        const close = chars[i + 1] === '(' ? ')' : ']';
        const e = findPair(chars, i + 2, '\\', close);
        if (e !== -1) {
          for (let k = i; k <= e; k++) out += chars[k];
          i = e + 1;
          continue;
        }
        // malformed opener: treat as literal text
        out += '\\textbackslash{}'; out += chars[i + 1]; i += 2; continue;
      }

      // Any other backslash: copy the command / escaped-char pair verbatim.
      if (c === '\\') {
        if (i + 1 < n) { out += '\\'; out += chars[i + 1]; i += 2; }
        else { out += '\\textbackslash{}'; i += 1; }
        continue;
      }

      // $$ … $$ (display) then $ … $ (inline): copy verbatim, else literal dollar.
      if (c === '$') {
        if (i + 1 < n && chars[i + 1] === '$') {
          const e = findPair(chars, i + 2, '$', '$');
          if (e !== -1) {
            for (let k = i; k <= e; k++) out += chars[k];
            i = e + 1;
            continue;
          }
          out += '\\$\\$'; i += 2; continue;
        }
        const e = findChar(chars, i + 1, '$');
        if (e !== -1) {
          for (let k = i; k <= e; k++) out += chars[k];
          i = e + 1;
          continue;
        }
        out += '\\$'; i += 1; continue;
      }

      // Outside math: escape LaTeX text specials.
      switch (c) {
        case '<': out += '$<$'; break;
        case '>': out += '$>$'; break;
        case '&': out += '\\&'; break;
        case '%': out += '\\%'; break;
        case '#': out += '\\#'; break;
        case '_': out += '\\_'; break;
        case '~': out += '\\textasciitilde{}'; break;
        case '^': out += '\\textasciicircum{}'; break;
        default: out += c;
      }
      i += 1;
    }
    return out;
  }

  /** Port of tol_str — LaTeX ` \pm <tol>[\%]`. */
  function tolStr(tol, marginType) {
    if (!tol) return '';
    const pct = marginType === 'percent' ? '\\%' : '';
    return ` \\pm ${tol}${pct}`;
  }

  /** Port of strip_round_instruction. */
  function stripRoundInstruction(text) {
    const s = String(text || '');
    const pos = s.lastIndexOf('Round');
    if (pos === -1) return s;
    const beforeTrimmed = s.slice(0, pos).replace(/\s+$/, '');
    if (pos === 0 || /[.?!]$/.test(beforeTrimmed)) return beforeTrimmed;
    return s;
  }

  /**
   * Port of q_to_latex (main.rs:593). `figInclude` is the argument to pass to
   * \includegraphics (basename; the surrounding \graphicspath resolves the dir)
   * or null when the question has no figure.
   */
  function qToLatex(q, num, version, figInclude) {
    const qtype = getQtype(q);
    const qdata = q[qtype] || {};
    const rawText = qdata.text || '';
    let body = html2tex(latexToHtml(rawText));
    if (qtype === 'numerical') {
      body = stripRoundInstruction(body);
      body += '\n\nPlease show your work in the space below.';
    }
    const figLatex = figInclude
      ? `\n\\begin{center}\\includegraphics[width=0.8\\linewidth,keepaspectratio]{${figInclude}}\\end{center}\n`
      : '';
    const out = [`\\question[3] % Q${num}`, body, figLatex, ''];

    if (qtype === 'numerical') {
      out.push('\\vspace{4mm}\\underline{\\hspace{4cm}} \\textit{(Numerical)}');
      out.push('\\vspace{6cm}');
      out.push('');
    } else if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
      out.push('\\begin{choices}');
      const answersVal = qdata.answers || [];
      const answerList = extractMcAnswers(answersVal);
      if (!answersHaveLock(answersVal)) seededShuffle(answerList, seedFor(version, num));
      for (const [, atxt, correct] of answerList) {
        const cmd = correct ? '\\CorrectChoice' : '\\choice';
        out.push(`  ${cmd} ${html2tex(atxt)}`);
      }
      out.push('\\end{choices}');
    } else if (qtype === 'true_false') {
      out.push('\\begin{choices}');
      out.push('  \\choice True');
      out.push('  \\choice False');
      out.push('\\end{choices}');
    } else if (qtype === 'essay') {
      out.push('\\vspace{4cm}');
    }
    out.push('');
    return out.join('\n');
  }

  /** Pick this version's questions from a cart item (shared start-offset logic). */
  function pickItemQuestions(item, version) {
    const raw = item.rawData || {};
    const questions = raw.questions || [];
    if (!questions.length) return [];
    const qn = Math.max(1, Number(item.qn) || 1);
    const n = questions.length;
    const start = (((Number(version) - 1) * qn) % n + n) % n;
    const picked = [];
    for (let i = 0; i < qn; i++) picked.push(questions[(start + i) % n]);
    return picked;
  }

  /**
   * Build the full exam .tex. Port of build_exam_latex (main.rs:873).
   * opts.graphicspathDirs — dirs for the \graphicspath line (default: common
   * relative subdirs for a single .tex; the bundle exporter passes ['../Images/']).
   */
  function buildExamLatex(cart, version, title, opts) {
    opts = opts || {};
    const graphicspathDirs = opts.graphicspathDirs
      || ['./', 'Figures/', 'figures/', 'Images/', 'images/'];

    const picked = [];
    for (const item of (Array.isArray(cart) ? cart : [])) {
      for (const q of pickItemQuestions(item, version)) picked.push(q);
    }

    let anyFigure = false;
    const body = picked.map((q, idx) => {
      const qtype = getQtype(q);
      const qdata = q[qtype] || {};
      let figInclude = null;
      if (qdata.figure) { figInclude = basename(qdata.figure); anyFigure = true; }
      return qToLatex(q, idx + 1, version, figInclude);
    }).join('\n\n');

    const graphicspathLine = anyFigure
      ? `\\graphicspath{${graphicspathDirs.map((d) => `{${d}}`).join('')}}\n`
      : '';

    return `\\documentclass[12pt,addpoints]{exam}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,physics,geometry,microtype,graphicx,textcomp,gensymb}
\\geometry{margin=1in}
${graphicspathLine}%\\printanswers  % uncomment to show answers (e.g. for instructor copy)

\\begin{document}
\\begin{center}
  {\\Large\\bfseries ${latexEscapeText(title)}}\\\\[4pt]
  Version ${versionLabel(version)} \\quad \\today
\\end{center}
\\vspace{2mm}\\hrule\\vspace{2mm}
Name:\\underline{\\hspace{8cm}} \\hfill Score: \\underline{\\hspace{2cm}} / \\numpoints
\\vspace{6mm}
\\begin{questions}
${body}
\\end{questions}
\\end{document}
`;
  }

  /** Build the answer-key .tex. Port of build_key_latex (main.rs:929). */
  function buildKeyLatex(cart, version, title) {
    const rows = [];
    for (const item of (Array.isArray(cart) ? cart : [])) {
      const picked = pickItemQuestions(item, version);
      for (const q of picked) {
        const qtype = getQtype(q);
        const qdata = q[qtype] || {};
        const qNum = rows.length + 1;
        if (qtype === 'numerical') {
          const ans = qdata.answer || {};
          let val;
          if (ans.value == null) val = '?';
          else val = typeof ans.value === 'string' ? ans.value : String(ans.value);
          const tol = ans.tolerance || '';
          const mt = ans.margin_type || '';
          rows.push(`  \\item $${val}${tolStr(tol, mt)}$`);
        } else if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
          const ansVal = qdata.answers || [];
          const answerList = extractMcAnswers(ansVal);
          if (!answersHaveLock(ansVal)) seededShuffle(answerList, seedFor(version, qNum));
          const letters = [];
          answerList.forEach(([, , correct], j) => {
            if (correct) letters.push(String.fromCharCode(65 + j));
          });
          rows.push(`  \\item ${letters.length ? letters.join(', ') : '?'}`);
        } else if (qtype === 'true_false') {
          rows.push(`  \\item ${qdata.answer ? 'True' : 'False'}`);
        } else {
          rows.push('  \\item [See rubric]');
        }
      }
    }

    return `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,geometry,textcomp,gensymb}
\\geometry{margin=1in}
\\begin{document}
\\section*{${latexEscapeText(title)} --- Version ${versionLabel(version)} --- Answer Key}
\\begin{enumerate}
${rows.join('\n')}
\\end{enumerate}
\\end{document}
`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // B) Bundle export — Exams/ Keys/ Images/ in one .zip (port of export_exam_bundle)
  // ══════════════════════════════════════════════════════════════════════════

  /** Decode a `data:...;base64,....` URL into a Uint8Array (+ mime). */
  function dataUrlToBytes(dataUrl) {
    const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const isB64 = !!m[2];
    const raw = isB64 ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime };
  }

  /**
   * Build the full bundle as a JSZip Blob. Mirrors export_exam_bundle: for N
   * versions, every exam+key .tex plus the referenced figures, laid out as
   * Exams/, Keys/, Images/. \includegraphics uses the figure basename and the
   * exam \graphicspath is set to ../Images/ so the paths resolve from Exams/.
   * @returns {Promise<Blob>}
   */
  async function buildBundleZip(cart, versions, title, bankSource) {
    if (!global.JSZip) throw new Error('JSZip not loaded');
    const zip = new global.JSZip();
    const examsDir = zip.folder('Exams');
    const keysDir = zip.folder('Keys');
    const imagesDir = zip.folder('Images');

    // Collect referenced figures (deduped by basename), fetched via the source.
    let imagesCopied = 0;
    if (bankSource && typeof bankSource.resolveFigure === 'function') {
      const seen = new Set();
      for (const item of (Array.isArray(cart) ? cart : [])) {
        const bankRef = item.bankRef || { path: item.path, handle: { path: item.path } };
        const raw = item.rawData || {};
        for (const q of (raw.questions || [])) {
          const qtype = getQtype(q);
          const qdata = q[qtype] || {};
          if (!qdata.figure) continue;
          const base = basename(qdata.figure);
          if (!base || seen.has(base)) continue;
          seen.add(base);
          let dataUrl = null;
          try { dataUrl = await bankSource.resolveFigure(bankRef, qdata, bankRef); }
          catch (_e) { dataUrl = null; }
          if (!dataUrl) continue;
          const decoded = dataUrlToBytes(dataUrl);
          if (decoded) { imagesDir.file(base, decoded.bytes); imagesCopied += 1; }
        }
      }
    }

    const nv = Math.max(1, Number(versions) || 1);
    for (let v = 1; v <= nv; v++) {
      const examTex = buildExamLatex(cart, v, title, { graphicspathDirs: ['../Images/'] });
      const keyTex = buildKeyLatex(cart, v, title);
      examsDir.file(`exam_${versionLabel(v)}.tex`, examTex);
      keysDir.file(`key_${versionLabel(v)}.tex`, keyTex);
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    blob.__imagesCopied = imagesCopied; // informational
    return blob;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C) Word .docx export — BETA (math fidelity limited). See header for why.
  //    Produces a Word-openable HTML ".doc" with math rendered to MathML by KaTeX.
  // ══════════════════════════════════════════════════════════════════════════

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  /** Render one LaTeX expression to MathML via KaTeX; fall back to plain text. */
  function mathToMathml(expr, display) {
    const src = String(expr || '').trim();
    if (global.katex && typeof global.katex.renderToString === 'function') {
      try {
        const html = global.katex.renderToString(src, {
          output: 'mathml', displayMode: !!display, throwOnError: false,
        });
        const m = /<math[\s\S]*?<\/math>/.exec(html);
        if (m) return m[0];
      } catch (_e) { /* fall through */ }
    }
    // Fallback: monospace literal so the expression is at least legible.
    const tag = display ? 'div' : 'span';
    return `<${tag} style="font-family:'Cambria Math','DejaVu Sans Mono',monospace">${escHtml(src)}</${tag}>`;
  }

  /**
   * Convert a question/answer string to inline Word-friendly HTML: <latex> and
   * $…$ / \(…\) / $$…$$ / \[…\] become MathML, **bold** / <strong> stay bold.
   */
  function textToDocHtml(text) {
    // reuse latexToHtml to normalise <latex> + **bold**, then swap math delimiters
    let s = latexToHtml(String(text || ''));
    const out = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      const two = s.slice(i, i + 2);
      if (two === '$$') {
        const end = s.indexOf('$$', i + 2);
        if (end !== -1) { out.push(mathToMathml(s.slice(i + 2, end), true)); i = end + 2; continue; }
      }
      if (two === '\\[') {
        const end = s.indexOf('\\]', i + 2);
        if (end !== -1) { out.push(mathToMathml(s.slice(i + 2, end), true)); i = end + 2; continue; }
      }
      if (two === '\\(') {
        const end = s.indexOf('\\)', i + 2);
        if (end !== -1) { out.push(mathToMathml(s.slice(i + 2, end), false)); i = end + 2; continue; }
      }
      if (s[i] === '$') {
        const end = s.indexOf('$', i + 1);
        if (end !== -1) { out.push(mathToMathml(s.slice(i + 1, end), false)); i = end + 1; continue; }
      }
      // pass through <strong>/<b>/<em> as-is (Word understands them); escape stray <>&
      if (s[i] === '<') {
        const close = s.indexOf('>', i);
        if (close !== -1 && /^<\/?(strong|b|em|i|sup|sub)>$/i.test(s.slice(i, close + 1))) {
          out.push(s.slice(i, close + 1)); i = close + 1; continue;
        }
        out.push('&lt;'); i += 1; continue;
      }
      if (s[i] === '&') { out.push('&amp;'); i += 1; continue; }
      out.push(s[i]); i += 1;
    }
    return out.join('');
  }

  function docWrap(titleText, bodyHtml) {
    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escHtml(titleText)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
body{font-family:Calibri,'Segoe UI',sans-serif;font-size:11pt;color:#111;line-height:1.5;}
h1{font-size:16pt;} .qnum{font-weight:bold;} .qtype{color:#666;font-weight:normal;}
.beta{color:#a33;font-size:9pt;} .ans{margin:.1cm 0;} .work{color:#999;font-style:italic;}
.correct{color:#1a7a35;font-weight:bold;} img{max-width:480px;}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  /** Build a Word-openable exam .doc (HTML). Async — resolves figures to images. */
  async function buildExamDoc(cart, version, title, bankSource) {
    const blocks = [];
    let qNum = 0;
    for (const item of (Array.isArray(cart) ? cart : [])) {
      const bankRef = item.bankRef || { path: item.path, handle: { path: item.path } };
      const picked = pickItemQuestions(item, version);
      for (const q of picked) {
        const qtype = getQtype(q);
        const qdata = q[qtype] || {};
        qNum += 1;
        let html = `<p><span class="qnum">${qNum}.</span> <span class="qtype">(${escHtml(typeLabel(qtype))})</span> ${textToDocHtml(qdata.text || '')}</p>`;

        if (bankSource && typeof bankSource.resolveFigure === 'function' && qdata.figure) {
          try {
            const url = await bankSource.resolveFigure(bankRef, qdata, bankRef);
            if (url) html += `<p><img src="${escAttr(url)}" alt="figure"></p>`;
          } catch (_e) { /* ignore */ }
        }

        if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
          const ansVal = qdata.answers || [];
          const answerList = extractMcAnswers(ansVal);
          if (!answersHaveLock(ansVal)) seededShuffle(answerList, seedFor(version, qNum));
          answerList.forEach(([, atxt], j) => {
            html += `<p class="ans">${String.fromCharCode(65 + j)}. ${textToDocHtml(atxt)}</p>`;
          });
        } else if (qtype === 'true_false') {
          html += '<p class="ans">A. True</p><p class="ans">B. False</p>';
        } else {
          html += '<p class="work">Work space</p>';
        }
        blocks.push(html);
      }
    }
    const head = `<h1>${escHtml(title)} — Version ${versionLabel(version)}</h1>
<p class="beta">Word export (beta) — math rendered as MathML; fidelity is limited vs. the desktop pandoc path.</p>
<p><b>Name:</b> ______________________________ &nbsp;&nbsp; <b>Score:</b> ________</p><hr>`;
    return docWrap(`${title} — Version ${versionLabel(version)}`, head + blocks.join('\n'));
  }

  /** Build a Word-openable answer-key .doc (HTML). */
  function buildKeyDoc(cart, version, title) {
    const rows = [];
    for (const item of (Array.isArray(cart) ? cart : [])) {
      const picked = pickItemQuestions(item, version);
      for (const q of picked) {
        const qtype = getQtype(q);
        const qdata = q[qtype] || {};
        const qNum = rows.length + 1;
        let ans;
        if (qtype === 'numerical') {
          const a = qdata.answer || {};
          let val = a.value == null ? '?' : (typeof a.value === 'string' ? a.value : String(a.value));
          const tol = a.tolerance || '';
          const mt = a.margin_type || '';
          const ts = tol ? ` ± ${tol}${mt === 'percent' ? '%' : ''}` : '';
          ans = textToDocHtml(`$${val}$`) + escHtml(ts);
        } else if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
          const ansVal = qdata.answers || [];
          const answerList = extractMcAnswers(ansVal);
          if (!answersHaveLock(ansVal)) seededShuffle(answerList, seedFor(version, qNum));
          const letters = [];
          answerList.forEach(([, , correct], j) => { if (correct) letters.push(String.fromCharCode(65 + j)); });
          ans = letters.length ? letters.join(', ') : '?';
        } else if (qtype === 'true_false') {
          ans = qdata.answer ? 'True' : 'False';
        } else {
          ans = '[See rubric]';
        }
        rows.push(`<p class="ans"><span class="qnum">${qNum}.</span> <span class="correct">${ans}</span></p>`);
      }
    }
    const head = `<h1>${escHtml(title)} — Version ${versionLabel(version)} — Answer Key</h1>
<p class="beta">Word export (beta) — math rendered as MathML; fidelity is limited vs. the desktop pandoc path.</p><hr>`;
    return docWrap(`${title} — Version ${versionLabel(version)} — Answer Key`, head + rows.join('\n'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // D) GitHub "Get Problem Banks" — browser BankSource over the git trees API
  // ══════════════════════════════════════════════════════════════════════════

  function githubErrorMessage(status, msg) {
    const m = String(msg || '').toLowerCase();
    if (status === 403 && m.includes('rate limit')) {
      return 'GitHub API rate limit reached (anonymous use is 60 requests/hour). '
        + 'Paste a personal-access token to raise it. (' + msg + ')';
    }
    if (status === 404) {
      return 'GitHub repo or branch not found (HTTP 404). Check the owner/name and branch. (' + msg + ')';
    }
    if (status === 401) {
      return 'GitHub rejected the token (HTTP 401). Check the personal-access token. (' + msg + ')';
    }
    return `GitHub API error (HTTP ${status}): ${msg}`;
  }

  function bytesToDataUrl(bytes, filename) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const name = String(filename || '').toLowerCase();
    let mime = 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
    else if (name.endsWith('.gif')) mime = 'image/gif';
    else if (name.endsWith('.svg')) mime = 'image/svg+xml';
    else if (name.endsWith('.webp')) mime = 'image/webp';
    return `data:${mime};base64,${b64}`;
  }

  // Build question objects for the preview panel using exported EstelaBankSource
  // helpers (mirrors bank-source.js buildQuestionsFromData, which is not exported).
  async function buildQuestionsPlus(data, bankRef, resolveFigureFn) {
    const qs = data.questions || [];
    const questions = [];
    for (const q of qs) {
      const qtype = getQtype(q);
      const qdata = q[qtype] || {};
      const body = latexToHtml(qdata.text || '');
      const answers = [];
      if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
        for (const [j, atxt, correct] of extractMcAnswers(qdata.answers || [])) {
          answers.push({ label: String.fromCharCode(65 + j), text: latexToHtml(atxt), correct });
        }
      } else if (qtype === 'numerical') {
        const ans = qdata.answer || {};
        let val = ans.value;
        if (val != null && typeof val !== 'string') val = String(val);
        val = val || '';
        const tol = ans.tolerance || '';
        const mt = ans.margin_type || '';
        const ts = tol ? ` ± ${tol}${mt === 'percent' ? '%' : ''}` : '';
        if (val && val !== 'null') answers.push({ label: 'Answer', text: `${val}${ts}`, correct: true });
      } else if (qtype === 'true_false') {
        answers.push({ label: 'Answer', text: qdata.answer ? 'True' : 'False', correct: true });
      }
      const groups = (qtype === 'categorization' && BS.buildCategorizationGroups)
        ? BS.buildCategorizationGroups(qdata) : null;
      const fb = qdata.feedback || {};
      const solution = latexToHtml(fb.general || '');
      const fig_url = resolveFigureFn ? await resolveFigureFn(bankRef, qdata, bankRef) : null;
      questions.push({
        id: qdata.id || `q${questions.length + 1}`,
        title: qdata.title || '', type: qtype, type_label: typeLabel(qtype),
        body, answers, groups, solution, fig_url,
      });
    }
    return questions;
  }

  const FIG_SUBDIRS = ['Figures', 'Figure', 'figures', 'figure', 'Images', 'images'];
  const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
  const BANK_EXT = ['.yaml', '.yml'];

  function hasExt(name, exts) {
    const n = String(name).toLowerCase();
    return exts.some((e) => n.endsWith(e));
  }

  /**
   * A read-only BankSource backed by the GitHub git-trees + raw.githubusercontent
   * APIs. Plugs into the existing app: set S.bankSource = new GitHubSource({...})
   * then call loadRepo() and everything (browse/preview/cart/export) just works.
   */
  class GitHubSource {
    constructor(opts) {
      opts = opts || {};
      this.id = 'github';
      this.label = 'GitHub';
      this.repo = (opts.repo || DEFAULT_REPO).trim();
      this.branch = (opts.branch || 'main').trim();
      this.token = (opts.token || '').trim();
      this.courses = Array.isArray(opts.courses) && opts.courses.length ? opts.courses : null;
      this._tree = null;
      this._pathSet = null;
      this._textCache = new Map();
      this._byteCache = new Map();
      this.truncated = false;
      this._displayName = `github:${this.repo}@${this.branch}`;
    }

    getDisplayPath() { return this._displayName; }

    _apiHeaders() {
      const h = { Accept: 'application/vnd.github+json' };
      if (this.token) h.Authorization = `Bearer ${this.token}`;
      return h;
    }

    _rawUrl(path) {
      const enc = String(path).split('/').map(encodeURIComponent).join('/');
      return `https://raw.githubusercontent.com/${this.repo}/${this.branch}/${enc}`;
    }

    async _ensureTree() {
      if (this._tree) return this._tree;
      const url = `https://api.github.com/repos/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`;
      let resp;
      try { resp = await fetch(url, { headers: this._apiHeaders() }); }
      catch (e) { throw new Error(`Network error contacting GitHub: ${e && e.message ? e.message : e}`); }
      let body = null;
      try { body = await resp.json(); } catch (_e) { body = null; }
      if (!body || !Array.isArray(body.tree)) {
        throw new Error(githubErrorMessage(resp.status, (body && body.message) || 'unexpected non-array response'));
      }
      this.truncated = !!body.truncated;
      this._tree = body.tree;
      this._pathSet = new Set(body.tree.filter((e) => e.type === 'blob').map((e) => e.path));
      return this._tree;
    }

    _courseOk(top) {
      if (!top || SKIP_COURSES.includes(top) || top.startsWith('.')) return false;
      if (this.courses && !this.courses.includes(top)) return false;
      return true;
    }

    async listCourses() {
      // Only offer top-level dirs that actually contain at least one bank YAML
      // (outside SKIP_DIRS). This is a small improvement over the desktop's
      // fetch_remote_courses, which lists every non-skipped top-level dir and so
      // surfaces empty folders like "docs".
      const tree = await this._ensureTree();
      const set = new Set();
      for (const e of tree) {
        if (e.type !== 'blob' || !hasExt(e.path, BANK_EXT)) continue;
        const parts = e.path.split('/');
        const top = parts[0];
        if (!top || SKIP_COURSES.includes(top) || top.startsWith('.')) continue;
        if (parts.slice(1).some((part) => SKIP_DIRS.includes(part))) continue;
        set.add(top);
      }
      return [...set].sort();
    }

    async _fetchText(path) {
      if (this._textCache.has(path)) return this._textCache.get(path);
      let text = null;
      try {
        const resp = await fetch(this._rawUrl(path), this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {});
        if (resp.ok) text = await resp.text();
      } catch (_e) { text = null; }
      // Cache successes only: a transient failure (network blip, 429/5xx) must
      // not poison the cache and permanently drop this bank for the session.
      if (text != null) this._textCache.set(path, text);
      return text;
    }

    async _fetchBytes(path) {
      if (this._byteCache.has(path)) return this._byteCache.get(path);
      let bytes = null;
      try {
        const resp = await fetch(this._rawUrl(path), this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {});
        if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
      } catch (_e) { bytes = null; }
      // Cache successes only (see _fetchText) so a transient figure-fetch
      // failure can still be retried instead of resolving null forever.
      if (bytes != null) this._byteCache.set(path, bytes);
      return bytes;
    }

    async scan() {
      const tree = await this._ensureTree();
      const paths = tree.filter((e) => e.type === 'blob').map((e) => e.path);

      // course → topic → yaml-bank-paths, honouring SKIP_DIRS in the tail.
      const byCourseTopic = new Map();
      for (const p of paths) {
        if (!hasExt(p, BANK_EXT)) continue;
        const parts = p.split('/');
        if (parts.length < 3) continue; // need course/topic/.../bank.yaml
        const [course, topic] = parts;
        if (!this._courseOk(course) || topic.startsWith('.')) continue;
        const relFromTopic = parts.slice(2);
        if (relFromTopic.some((part) => SKIP_DIRS.includes(part))) continue;
        const key = `${course}\u0000${topic}`;
        if (!byCourseTopic.has(key)) byCourseTopic.set(key, []);
        byCourseTopic.get(key).push(p);
      }

      const result = {};
      // parse all candidate YAMLs (in parallel) then assemble the structure
      const allYamlPaths = [...byCourseTopic.values()].flat();
      const parsed = new Map();
      await Promise.all(allYamlPaths.map(async (p) => {
        const text = await this._fetchText(p);
        if (!text) return;
        let data;
        try { data = BS.parseYaml ? BS.parseYaml(text) : null; } catch (_e) { return; }
        if (!data || !BS.isBank || !BS.isBank(data)) return;
        const status = (data.bank_info && data.bank_info.status) || '';
        if (status === 'draft' || status === 'deprecated') return;
        parsed.set(p, data);
      }));

      for (const [key, yamlPaths] of byCourseTopic) {
        const [course, topic] = key.split('\u0000');
        const banks = [];
        for (const p of yamlPaths.sort()) {
          const data = parsed.get(p);
          if (!data) continue;
          const meta = BS.bankMeta ? BS.bankMeta(data) : { title: p, q_count: (data.questions || []).length, q_types: {} };
          const bankDirPath = p.slice(0, p.lastIndexOf('/') + 1);
          const bankRef = {
            id: p, path: p, meta, sourceKind: 'github',
            handle: { path: p, bankDirPath },
          };
          // QTI zip sitting next to the bank (top level of bankDir)
          meta.has_qti = this._pathSet && [...this._pathSet].some(
            (z) => z.startsWith(bankDirPath) && z.toLowerCase().endsWith('.zip')
              && !z.slice(bankDirPath.length).includes('/')
          );
          banks.push({ path: p, meta, bankRef });
        }
        if (banks.length) {
          if (!result[course]) result[course] = {};
          result[course][topic] = banks;
        }
      }
      return { data: result };
    }

    async loadBank(ref) {
      const path = typeof ref === 'string' ? ref : (ref && (ref.path || (ref.handle && ref.handle.path)));
      if (!path) throw new Error('Invalid bank reference for GitHub source');
      const text = await this._fetchText(path);
      if (!text) throw new Error('Failed to fetch bank from GitHub');
      const data = BS.parseYaml(text);
      if (!BS.isBank(data)) throw new Error('Invalid bank');
      const meta = BS.bankMeta(data);
      const bankDirPath = path.slice(0, path.lastIndexOf('/') + 1);
      const bankRef = (ref && ref.handle) ? ref
        : { id: path, path, meta, sourceKind: 'github', handle: { path, bankDirPath } };
      const questions = await buildQuestionsPlus(data, bankRef, (r, qd, br) => this.resolveFigure(r, qd, br));
      return { meta, rawData: data, questions, bankRef };
    }

    async loadBankText(ref) {
      const path = typeof ref === 'string' ? ref : (ref && (ref.path || (ref.handle && ref.handle.path)));
      if (!path) return null;
      return this._fetchText(path);
    }

    async resolveFigure(_ref, qdata, bankRef) {
      const fig = qdata && qdata.figure;
      const bankDir = bankRef && bankRef.handle && bankRef.handle.bankDirPath;
      if (!fig || bankDir == null) return null;
      const base = basename(fig);
      const rels = [fig.replace(/\\/g, '/')];
      for (const sub of FIG_SUBDIRS) rels.push(`${sub}/${base}`);
      for (const rel of rels) {
        const full = bankDir + rel;
        if (this._pathSet && !this._pathSet.has(full)) continue; // skip guaranteed-404s
        const bytes = await this._fetchBytes(full);
        if (bytes) return bytesToDataUrl(bytes, base);
      }
      return null;
    }

    async getQtiPackage(ref) {
      const path = typeof ref === 'string' ? ref : (ref && (ref.path || (ref.handle && ref.handle.path)));
      if (!path || !this._pathSet) return null;
      const bankDir = path.slice(0, path.lastIndexOf('/') + 1);
      const bankId = (ref && ref.meta && ref.meta.bank_id) || '';
      const candidates = [...this._pathSet].filter(
        (z) => z.startsWith(bankDir) && z.toLowerCase().endsWith('.zip')
          && !z.slice(bankDir.length).includes('/')
      );
      for (const p of candidates) {
        const bytes = await this._fetchBytes(p);
        if (!bytes) continue;
        let ok = true;
        if (global.JSZip) {
          try { ok = !!(await global.JSZip.loadAsync(bytes)).file('imsmanifest.xml'); }
          catch (_e) { ok = false; }
        }
        if (ok) {
          const name = bankId ? `${bankId}-canvas-qti.zip` : basename(p).replace(/\.zip$/i, '') + '-canvas-qti.zip';
          return { bytes, filename: name };
        }
      }
      return null;
    }

    findBankRef(repoData, path) {
      for (const topics of Object.values(repoData || {})) {
        for (const banks of Object.values(topics)) {
          for (const b of banks) if (b.path === path) return b.bankRef;
        }
      }
      return null;
    }

    /**
     * Build a .zip of the fetched repo content (banks + figures + QTI zips) for
     * the selected courses, mirroring scripts/build_standalone_html.py include
     * rules. This is the browser equivalent of download_courses' on-disk extract.
     * @returns {Promise<Blob>}
     */
    async buildDownloadZip() {
      if (!global.JSZip) throw new Error('JSZip not loaded');
      const tree = await this._ensureTree();
      const zip = new global.JSZip();
      let count = 0;
      const blobs = tree.filter((e) => e.type === 'blob');
      for (const e of blobs) {
        const parts = e.path.split('/');
        const course = parts[0];
        if (!this._courseOk(course)) continue;
        if (parts.slice(1).some((part) => SKIP_DIRS.includes(part))) continue;
        const name = basename(e.path);
        const isBank = hasExt(name, BANK_EXT);
        const isImg = hasExt(name, IMAGE_EXT);
        const isZip = name.toLowerCase().endsWith('.zip');
        if (!isBank && !isImg && !isZip) continue;
        const bytes = await this._fetchBytes(e.path);
        if (!bytes) continue;
        // QTI zips can't be usefully re-verified here; include all .zip near banks
        zip.file(e.path, bytes);
        count += 1;
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      blob.__fileCount = count;
      return blob;
    }
  }

  /** Convenience: list courses without constructing a persistent source first. */
  async function githubListCourses(opts) {
    return new GitHubSource(opts).listCourses();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Self-tests / verification notes (run in Node or via the browser console).
  // ══════════════════════════════════════════════════════════════════════════

  function runSelfTests() {
    const results = [];
    const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

    // 1) html2tex escapes bare specials OUTSIDE math but leaves math intact.
    const src = 'In a 50% brine, salt & water cost #1 with x_0 and a~b, e^2, plus $E=mc^2$ and \\(v_0=3\\).';
    const tex = html2tex(latexToHtml(src));
    check('html2tex escapes % outside math', tex.includes('50\\%') && !tex.includes('50%'), tex);
    check('html2tex escapes & outside math', tex.includes('salt \\& water'));
    check('html2tex escapes # outside math', tex.includes('\\#1'));
    check('html2tex escapes _ outside math', tex.includes('x\\_0'));
    check('html2tex escapes ~ outside math', tex.includes('a\\textasciitilde{}b'));
    check('html2tex escapes ^ outside math', tex.includes('\\textasciicircum{}2'));
    check('html2tex leaves inline $..$ math intact', tex.includes('$E=mc^2$'));
    check('html2tex leaves \\(..\\) math intact', tex.includes('\\(v_0=3\\)'));

    // 1b) dollar / display-math edge cases (parity with main.rs char loop).
    check('html2tex escapes a stray (unmatched) $ to \\$',
      html2tex('Costs $5 to enter') === 'Costs \\$5 to enter',
      html2tex('Costs $5 to enter'));
    check('html2tex escapes an unmatched $$ to \\$\\$',
      html2tex('a lone $$ here') === 'a lone \\$\\$ here',
      html2tex('a lone $$ here'));
    check('html2tex passes $$..$$ display math through verbatim',
      html2tex('see $$a+b=c$$ end').includes('$$a+b=c$$'));
    check('html2tex passes \\[..\\] block math through verbatim',
      html2tex('X \\[y = 1\\] Z').includes('\\[y = 1\\]'));

    // title escaping
    check('latexEscapeText escapes title specials',
      latexEscapeText('Q&A #1: 50% _x_') === 'Q\\&A \\#1: 50\\% \\_x\\_');

    // 2) bundle-mode exam .tex: graphicspath → ../Images/ and includegraphics basename.
    const cart = [{
      path: 'C/T/bank.yaml', qn: 2,
      rawData: {
        questions: [
          { multiple_choice: { text: 'Pick the 50% & correct one', answers: [
            { answer: { text: 'right', correct: true, lock: true } },
            { answer: { text: 'wrong', correct: false, lock: true } },
          ] } },
          { numerical: { text: 'Compute v. Round to 2 sig figs.', figure: 'ramp.png',
            answer: { value: '9.8', tolerance: '0.1', margin_type: 'percent' } } },
        ],
      },
    }];
    const bundleExam = buildExamLatex(cart, 1, 'Test & Exam', { graphicspathDirs: ['../Images/'] });
    check('bundle exam sets graphicspath ../Images/', bundleExam.includes('\\graphicspath{{../Images/}}'), bundleExam);
    check('bundle exam includegraphics uses basename', bundleExam.includes('{ramp.png}'));
    check('exam title escaped in \\bfseries', bundleExam.includes('\\bfseries Test \\& Exam}'));
    check('numerical strips "Round" instruction', bundleExam.includes('Compute v.') && !bundleExam.includes('Round to 2 sig'));
    check('numerical appends work prompt', bundleExam.includes('Please show your work in the space below.'));

    // key .tex uses \pm and \% for percent tolerance
    const key = buildKeyLatex(cart, 1, 'Test & Exam');
    check('key uses \\pm and \\% for percent tol', key.includes('\\item $9.8 \\pm 0.1\\%$'), key);
    check('key title escaped', key.includes('Test \\& Exam --- Version A --- Answer Key'));
    // locked MC → not shuffled → correct answer stays A
    check('key MC correct letter', /\\item\s+A\b/.test(key));

    // 3) GitHub rate-limit response → clear message; token hint present.
    const rl = githubErrorMessage(403, "API rate limit exceeded for 1.2.3.4");
    check('github rate-limit message is clear', /rate limit/i.test(rl) && /token/i.test(rl), rl);
    check('github 404 message is clear', /404/.test(githubErrorMessage(404, 'Not Found')));

    const passed = results.filter((r) => r.pass).length;
    return { passed, total: results.length, results };
  }

  global.EstelaExamExportPlus = {
    // LaTeX
    html2tex, latexEscapeText, tolStr, stripRoundInstruction, qToLatex,
    buildExamLatex, buildKeyLatex,
    // bundle
    dataUrlToBytes, buildBundleZip,
    // docx (beta)
    textToDocHtml, mathToMathml, buildExamDoc, buildKeyDoc,
    // github
    GitHubSource, githubListCourses, githubErrorMessage,
    // shared
    versionLabel, basename, pickItemQuestions, seedFor,
    // tests
    runSelfTests,
    DEFAULT_REPO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
