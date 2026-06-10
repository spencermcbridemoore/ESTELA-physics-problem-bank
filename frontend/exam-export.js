/**
 * JavaScript exam HTML export (port of Rust build_pdf_html).
 */
(function (global) {
  'use strict';

  const { getQtype, latexToHtml, extractMcAnswers } = global.EstelaBankSource;

  function versionLabel(v) {
    const n = Number(v);
    if (n >= 1 && n <= 26) return String.fromCharCode(64 + n);
    return String(n);
  }

  function answersHaveLock(answers) {
    if (!Array.isArray(answers)) return false;
    return answers.some((a) => a?.answer?.lock === true);
  }

  /** Simple seeded Fisher-Yates shuffle — deterministic per (version, question) */
  function seededShuffle(items, seed) {
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
  }

  function seedFor(version, qNum) {
    return BigInt(version) * 10000n + BigInt(qNum);
  }

  /**
   * Build exam HTML matching Rust build_pdf_html output.
   * @param {Array} cart - [{ path, meta, rawData, qn, bankRef? }]
   * @param {number} version
   * @param {string} title
   * @param {boolean} includeAnswers
   * @param {object} bankSource - active BankSource with resolveFigure()
   */
  async function buildExamHtml(cart, version, title, includeAnswers, bankSource) {
    const parts = [];
    let qNum = 0;

    for (const item of cart) {
      const raw = item.rawData || {};
      const questions = raw.questions || [];
      if (!questions.length) continue;

      const qn = Math.max(1, Number(item.qn) || 1);
      const n = questions.length;
      const start = (((Number(version) - 1) * qn) % n);

      const bankRef = item.bankRef || { path: item.path, handle: { path: item.path } };

      for (let i = 0; i < qn; i++) {
        const q = questions[(start + i) % n];
        const qtype = getQtype(q);
        const qdata = q[qtype] || {};
        const body = latexToHtml(qdata.text || '');

        let figHtml = '';
        if (bankSource?.resolveFigure) {
          const figUrl = await bankSource.resolveFigure(bankRef, qdata, bankRef);
          if (figUrl) {
            figHtml = `<div class="q-fig"><img src="${figUrl}" style="max-width:100%;margin:.4cm 0;"></div>`;
          }
        }

        let ansHtml = '';
        if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
          const ansVal = qdata.answers || [];
          const answerList = extractMcAnswers(ansVal).map(([j, atxt, correct]) => [j, atxt, correct]);
          if (!answersHaveLock(ansVal)) {
            seededShuffle(answerList, seedFor(version, qNum));
          }
          for (let j = 0; j < answerList.length; j++) {
            const [, atxt, correct] = answerList[j];
            const cls = includeAnswers && correct ? 'ans-ok' : 'ans-opt';
            const letter = String.fromCharCode(65 + j);
            ansHtml += `<div class="${cls}"><b>${letter}.</b> ${latexToHtml(atxt)}</div>`;
          }
        } else if (qtype === 'numerical') {
          if (includeAnswers) {
            const ans = qdata.answer || {};
            let val = ans.value;
            if (val != null && typeof val !== 'string') val = String(val);
            val = val || '';
            const tol = ans.tolerance || '';
            const mt = ans.margin_type || '';
            const ts = tol
              ? ` &plusmn; ${tol}${mt === 'percent' ? '%' : ''}`
              : '';
            if (val && val !== 'null') {
              ansHtml = `<div class="ans-ok"><b>Answer:</b> ${val}${ts}</div>`;
            }
          } else {
            ansHtml = '<div class="ans-space"></div>';
          }
        } else if (qtype === 'true_false') {
          if (includeAnswers) {
            const av = !!qdata.answer;
            ansHtml = `<div class="ans-ok"><b>Answer:</b> ${av ? 'True' : 'False'}</div>`;
          } else {
            ansHtml = '<div class="ans-opt"><b>A.</b> True</div><div class="ans-opt"><b>B.</b> False</div>';
          }
        } else if (!includeAnswers) {
          ansHtml = '<div class="ans-space" style="height:3cm"></div>';
        }

        const needsWorkArea = !includeAnswers
          && !['multiple_choice', 'multiple_answers', 'true_false'].includes(qtype);
        const work = needsWorkArea
          ? '<div class="work-area"><span class="work-lbl">Work</span></div>'
          : '';

        qNum += 1;
        parts.push(
          `<div class="sheet"><div class="q-num">Question ${qNum}</div><div class="q-body">${body}</div>${figHtml}<div class="ans-list">${ansHtml}</div>${work}</div>`
        );
      }
    }

    const label = includeAnswers ? ' \u2014 Answer Key' : '';
    const partsHtml = parts.join('\n');
    const verLabel = versionLabel(version);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAttr(title)} &#8212; Version ${verLabel}${label}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"><\/script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false}],throwOnError:false})">
<\/script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,600;9..40,700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;font-size:11pt;color:#1a1916;line-height:1.65;background:#eceae4;-webkit-font-smoothing:antialiased;}
.sheet{max-width:820px;margin:2rem auto;background:#fff;padding:2.2cm 2.6cm 2.4cm;box-shadow:0 2px 20px rgba(0,0,0,.08);}
.sheet:first-child{border-radius:6px 6px 0 0;margin-bottom:0;}
.sheet+.sheet{border-top:1px solid #e8e6df;margin-top:0;margin-bottom:0;}
.sheet:last-child{border-radius:0 0 6px 6px;margin-bottom:2rem;}
.sheet:only-child{border-radius:6px;margin-bottom:2rem;}
h1{font-size:18pt;font-weight:700;letter-spacing:-.02em;margin-bottom:.2cm;}
.meta{font-size:8.5pt;color:#999;margin-bottom:.5cm;}
hr{border:none;border-top:1.5px solid #e0ded6;margin:.5cm 0 .7cm;}
.name-row{display:flex;align-items:baseline;gap:.5cm;font-size:10pt;}
.name-row .line{border-bottom:1px solid #333;flex:1;height:1.3em;}
.name-row .score{border-bottom:1px solid #333;width:3cm;height:1.3em;}
.q-num{font-size:7.5pt;font-weight:600;color:#9b9890;text-transform:uppercase;letter-spacing:.09em;margin-bottom:.35cm;}
.q-body{font-size:11pt;line-height:1.75;margin-bottom:.45cm;}
.ans-list{display:flex;flex-direction:column;gap:.13cm;margin-bottom:.5cm;}
.ans-opt{padding:.15cm .38cm;border:1px solid #e8e6df;border-radius:5px;font-size:10pt;color:#3d3b35;}
.ans-ok{padding:.15cm .38cm;border:1px solid rgba(26,122,53,.35);background:rgba(26,122,53,.06);border-radius:5px;font-size:10pt;color:#1a7a35;}
.ans-space{border-bottom:1px solid #bbb;height:1.2cm;margin-bottom:.5cm;}
.work-area{border:1.5px dashed #d5d2c8;border-radius:7px;padding:.4cm .6cm;min-height:7cm;}
.work-lbl{font-size:7pt;color:#c5c2b8;text-transform:uppercase;letter-spacing:.1em;}
.q-fig img{max-width:100%;max-height:7cm;display:block;margin:.3cm auto;}
.katex-display{margin:.4cm 0;overflow-x:auto;}
@page{size:letter;margin:2cm 2.4cm;}
@media print{
  body{background:#fff;}
  .sheet{box-shadow:none;margin:0 !important;max-width:none;padding:0;border-radius:0 !important;border-top:none !important;break-after:page;page-break-after:always;}
  .sheet:last-child{break-after:auto;page-break-after:auto;}
  .work-area{min-height:6cm;}
  .q-fig img{max-height:5cm;}
}
</style>
</head>
<body>
<div class="sheet">
<h1>${escapeHtml(title)} &#8212; Version ${verLabel}${label}</h1>
<div class="meta">ESTELA Exam Builder &middot; UCF / NSF-2421299</div>
<hr>
<div class="name-row">Name:&nbsp;<div class="line"></div>&nbsp;&nbsp;&nbsp;Score:&nbsp;<div class="score"></div></div>
</div>
${partsHtml}
</body>
</html>`;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  global.EstelaExamExport = {
    versionLabel,
    getQtype,
    latexToHtml,
    extractMcAnswers,
    answersHaveLock,
    seededShuffle,
    buildExamHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
