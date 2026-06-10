/**
 * Polymorphic bank-source layer for ESTELA Exam Builder.
 * @typedef {Object} BankRef
 * @property {string} id
 * @property {string} path
 * @property {Object} meta
 * @property {string} sourceKind
 * @property {*} handle - opaque (path string, DirectoryHandle bundle, etc.)
 */

(function (global) {
  'use strict';

  const SKIP_DIRS = [
    'Old', 'old', 'Archive', 'archive', 'Older versions', 'Older Versions',
    'Drafts', 'drafts', 'Temporary', 'temporary', 'venv', '__pycache__',
    '.git', 'Scripts', 'scripts', 'Figure Creation', 'figure_creation',
  ];

  const SKIP_COURSES = [
    'venv', 'Templates', 'Bank Statistics', '.git',
    'frontend', 'src-tauri', 'src', 'node_modules', '.github',
    'target', 'dist', 'build',
  ];

  const QTYPES = [
    'numerical', 'multiple_choice', 'true_false', 'multiple_answers',
    'essay', 'categorization', 'ordering', 'fill_in_multiple_blanks',
    'formula', 'file_upload', 'hot_spot',
  ];

  // ── Shared YAML / meta helpers (mirror Rust main.rs) ─────────────────────

  function getQtype(q) {
    if (q && typeof q === 'object' && !Array.isArray(q)) {
      for (const k of QTYPES) {
        if (Object.prototype.hasOwnProperty.call(q, k)) return k;
      }
      const keys = Object.keys(q);
      if (keys.length) return keys[0];
    }
    return 'unknown';
  }

  function stripTags(text) {
    let s = String(text || '');
    s = s.replace(/<latex>[\s\S]*?<\/latex>/g, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    const cmdRe = /\\[a-zA-Z]+\{([^}]*)\}/g;
    while (cmdRe.test(s)) s = s.replace(cmdRe, '$1');
    s = s.replace(/\$\$([^$]*)\$\$/g, '$1');
    s = s.replace(/\$([^$]*)\$/g, '$1');
    s = s.replace(/\\/g, ' ').replace(/\*\*/g, '').replace(/\*/g, '');
    return s.trim().replace(/\s+/g, ' ');
  }

  function latexToHtml(text) {
    if (!text) return '';
    let result = String(text);
    result = result.replace(/<latex>\s*\n([\s\S]*?)\n\s*<\/latex>/g, '$$\n$1\n$$');
    result = result.replace(/<latex>([\s\S]*?)<\/latex>/g, '$$$1$');
    result = result.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
    return result;
  }

  function typeLabel(qtype) {
    const map = {
      numerical: 'Numerical',
      multiple_choice: 'Multiple Choice',
      multiple_answers: 'Multiple Answer',
      true_false: 'True / False',
      essay: 'Essay',
      formula: 'Formula',
      categorization: 'Categorization',
      fill_in_multiple_blanks: 'Fill-in-the-Blank',
      ordering: 'Ordering',
      hot_spot: 'Hot Spot',
    };
    return map[qtype] || qtype;
  }

  function yamlToPlain(obj) {
    if (obj instanceof Date) return obj.toISOString().slice(0, 10);
    if (Array.isArray(obj)) return obj.map(yamlToPlain);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = yamlToPlain(v);
      return out;
    }
    return obj;
  }

  function parseYaml(content) {
    if (!global.jsyaml) throw new Error('js-yaml not loaded');
    return yamlToPlain(global.jsyaml.load(content));
  }

  function isBank(data) {
    return Array.isArray(data?.questions);
  }

  function bankMeta(data) {
    const info = data?.bank_info || {};
    const qs = Array.isArray(data?.questions) ? data.questions : [];
    const typeCounts = {};
    for (const q of qs) {
      if (q && typeof q === 'object') {
        const t = getQtype(q);
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
    }
    let preview = '';
    if (qs.length && qs[0] && typeof qs[0] === 'object') {
      const qtype = getQtype(qs[0]);
      const text = qs[0][qtype]?.text || '';
      const clean = stripTags(text);
      preview = clean.length > 220 ? clean.slice(0, 220) + '…' : clean;
    }
    return {
      title: info.title || 'Untitled Bank',
      bank_id: info.bank_id || '',
      description: info.description || '',
      authors: info.authors || [],
      date_created: info['date created'] || info.date_created || '',
      lo: info['learning objectives'] || info.learning_objectives || [],
      q_count: qs.length,
      q_types: typeCounts,
      preview,
    };
  }

  function extractMcAnswers(answers) {
    const result = [];
    if (!Array.isArray(answers)) return result;
    for (let j = 0; j < answers.length; j++) {
      const a = answers[j];
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        result.push([j, typeof a === 'string' ? a : String(a ?? ''), false]);
        continue;
      }
      if (a.answer && typeof a.answer === 'object') {
        result.push([
          j,
          a.answer.text || '',
          !!a.answer.correct,
        ]);
      } else if ('text' in a) {
        result.push([j, a.text || '', !!a.correct]);
      } else {
        result.push([j, JSON.stringify(a), false]);
      }
    }
    return result;
  }

  async function fileToDataUrl(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const name = (file.name || '').toLowerCase();
    let mime = 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
    else if (name.endsWith('.gif')) mime = 'image/gif';
    else if (name.endsWith('.svg')) mime = 'image/svg+xml';
    return `data:${mime};base64,${b64}`;
  }

  async function blobToDataUrl(blob, mimeHint) {
    const mime = blob.type || mimeHint || 'image/png';
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${mime};base64,${btoa(binary)}`;
  }

  // ── TauriSource ───────────────────────────────────────────────────────────

  class TauriSource {
    constructor() {
      this.id = 'tauri';
      this.label = 'Tauri';
    }

    /** @param {string} rootRef */
    async scan(rootRef) {
      const result = await global.__TAURI__.core.invoke('scan_repo', { path: rootRef });
      const data = result.data || {};
      for (const topics of Object.values(data)) {
        for (const banks of Object.values(topics)) {
          for (const b of banks) {
            b.bankRef = this._makeRef(b.path, b.meta);
          }
        }
      }
      return result;
    }

    /** @param {BankRef|string} ref */
    async loadBank(ref) {
      const path = typeof ref === 'string' ? ref : (ref.path || ref.handle?.path);
      const result = await global.__TAURI__.core.invoke('bank_data', { path });
      return {
        meta: result.meta,
        rawData: result.rawData,
        questions: result.questions,
        bankRef: this._makeRef(path, result.meta),
      };
    }

    async resolveFigure(_ref, qdata, bankRef) {
      const fig = qdata?.figure;
      if (!fig) return null;
      const bankPath = bankRef?.path || bankRef?.handle?.path || _ref?.path;
      if (!bankPath) return null;
      const bankDir = bankPath.replace(/[/\\][^/\\]+$/, '');
      const basename = fig.replace(/\\/g, '/').split('/').pop();
      const relCandidates = [
        fig,
        `Figures/${basename}`,
        `Figure/${basename}`,
        `figures/${basename}`,
        `figure/${basename}`,
        `Images/${basename}`,
        `images/${basename}`,
      ];
      for (const rel of relCandidates) {
        const full = `${bankDir}/${rel}`.replace(/\\/g, '/');
        try {
          if (global.__TAURI__?.core?.convertFileSrc) {
            const url = global.__TAURI__.core.convertFileSrc(full);
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const blob = await resp.blob();
            return await blobToDataUrl(blob);
          }
        } catch (_e) { /* try next */ }
      }
      return null;
    }

    _makeRef(path, meta) {
      return {
        id: path,
        path,
        meta,
        sourceKind: 'tauri',
        handle: { path },
      };
    }
  }

  // ── DirectorySource ───────────────────────────────────────────────────────

  class DirectorySource {
    constructor() {
      this.id = 'directory';
      this.label = 'Directory';
      /** @type {FileSystemDirectoryHandle|null} */
      this._rootHandle = null;
      this._displayName = '';
    }

    getDisplayPath() {
      return this._displayName;
    }

    async ensureRoot() {
      if (this._rootHandle) return this._rootHandle;
      if (!global.showDirectoryPicker) {
        throw new Error('File System Access API not supported in this browser');
      }
      this._rootHandle = await global.showDirectoryPicker({ mode: 'read' });
      this._displayName = this._rootHandle.name;
      return this._rootHandle;
    }

    setRootHandle(handle, displayName) {
      this._rootHandle = handle;
      this._displayName = displayName || handle?.name || '';
    }

    /** @param {FileSystemDirectoryHandle} [rootRef] */
    async scan(rootRef) {
      const root = rootRef || await this.ensureRoot();
      const result = {};

      const courseEntries = [];
      for await (const [name, handle] of root) {
        if (handle.kind === 'directory') courseEntries.push({ name, handle });
      }
      courseEntries.sort((a, b) => a.name.localeCompare(b.name));

      for (const { name: courseName, handle: courseHandle } of courseEntries) {
        if (SKIP_COURSES.includes(courseName) || courseName.startsWith('.')) continue;

        const courseTopics = {};
        const topicEntries = [];
        for await (const [name, handle] of courseHandle) {
          if (handle.kind === 'directory') topicEntries.push({ name, handle });
        }
        topicEntries.sort((a, b) => a.name.localeCompare(b.name));

        for (const { name: topicName, handle: topicHandle } of topicEntries) {
          if (topicName.startsWith('.')) continue;
          const banks = [];
          await this._walkTopic(topicHandle, [], banks, courseName, topicName, root);
          if (banks.length) courseTopics[topicName] = banks;
        }

        if (Object.keys(courseTopics).length) result[courseName] = courseTopics;
      }

      return { data: result };
    }

    async _walkTopic(dirHandle, relParts, banks, courseName, topicName, rootHandle) {
      const entries = [];
      for await (const [name, handle] of dirHandle) entries.push({ name, handle });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      const subdirs = [];
      const files = [];
      for (const { name, handle } of entries) {
        if (handle.kind === 'directory') {
          if (!SKIP_DIRS.includes(name)) subdirs.push({ name, handle });
        } else {
          files.push({ name, handle });
        }
      }

      for (const { name, handle } of files) {
        const ext = name.split('.').pop()?.toLowerCase();
        if (ext !== 'yaml' && ext !== 'yml') continue;
        const relFromTopic = [...relParts, name];
        if (relFromTopic.some((p) => SKIP_DIRS.includes(p))) continue;

        let content;
        try {
          const file = await handle.getFile();
          content = await file.text();
        } catch (_e) {
          continue;
        }

        let data;
        try {
          data = parseYaml(content);
        } catch (_e) {
          continue;
        }
        if (!isBank(data)) continue;

        const status = data.bank_info?.status || '';
        if (status === 'draft' || status === 'deprecated') continue;

        const displayPath = `${courseName}/${topicName}/${relFromTopic.join('/')}`;
        const bankRef = this._makeRef(displayPath, bankMeta(data), {
          fileHandle: handle,
          bankDirHandle: dirHandle,
          rootHandle,
        });
        banks.push({ path: displayPath, meta: bankRef.meta, bankRef });
      }

      for (const { name, handle } of subdirs.reverse()) {
        await this._walkTopic(handle, [...relParts, name], banks, courseName, topicName, rootHandle);
      }
    }

    /** @param {BankRef|string} ref */
    async loadBank(ref) {
      const bankRef = typeof ref === 'object' && ref.handle ? ref : null;
      if (!bankRef?.handle?.fileHandle) {
        throw new Error('Invalid bank reference for directory source');
      }
      const file = await bankRef.handle.fileHandle.getFile();
      const data = parseYaml(await file.text());
      if (!isBank(data)) throw new Error('Invalid bank');
      const meta = bankMeta(data);
      const questions = await this._buildQuestions(data, bankRef);
      return { meta, rawData: data, questions, bankRef };
    }

    async _buildQuestions(data, bankRef) {
      const qs = data.questions || [];
      const questions = [];
      for (const q of qs) {
        const qtype = getQtype(q);
        const qdata = q[qtype] || {};
        const body = latexToHtml(qdata.text || '');

        const answers = [];
        if (qtype === 'multiple_choice' || qtype === 'multiple_answers') {
          const ansVal = qdata.answers || [];
          for (const [j, atxt, correct] of extractMcAnswers(ansVal)) {
            answers.push({
              label: String.fromCharCode(65 + j),
              text: latexToHtml(atxt),
              correct,
            });
          }
        } else if (qtype === 'numerical') {
          const ans = qdata.answer || {};
          let val = ans.value;
          if (val != null && typeof val !== 'string') val = String(val);
          val = val || '';
          const tol = ans.tolerance || '';
          const mt = ans.margin_type || '';
          const ts = tol
            ? ` ± ${tol}${mt === 'percent' ? '%' : ''}`
            : '';
          if (val && val !== 'null') {
            answers.push({ label: 'Answer', text: `${val}${ts}`, correct: true });
          }
        } else if (qtype === 'true_false') {
          const av = !!qdata.answer;
          answers.push({ label: 'Answer', text: av ? 'True' : 'False', correct: true });
        }

        const fb = qdata.feedback || {};
        const solution = latexToHtml(fb.general || '');
        const fig_url = await this.resolveFigure(bankRef, qdata, bankRef);

        questions.push({
          id: qdata.id || `q${questions.length + 1}`,
          title: qdata.title || '',
          type: qtype,
          type_label: typeLabel(qtype),
          body,
          answers,
          solution,
          fig_url,
        });
      }
      return questions;
    }

    async resolveFigure(_ref, qdata, bankRef) {
      const fig = qdata?.figure;
      if (!fig || !bankRef?.handle?.bankDirHandle) return null;
      const bankDir = bankRef.handle.bankDirHandle;
      const basename = fig.replace(/\\/g, '/').split('/').pop();
      const candidates = [
        () => this._getFileByRelativePath(bankDir, fig),
        () => this._getFileInSubdir(bankDir, 'Figures', basename),
        () => this._getFileInSubdir(bankDir, 'Figure', basename),
        () => this._getFileInSubdir(bankDir, 'figures', basename),
        () => this._getFileInSubdir(bankDir, 'figure', basename),
        () => this._getFileInSubdir(bankDir, 'Images', basename),
        () => this._getFileInSubdir(bankDir, 'images', basename),
      ];
      for (const tryGet of candidates) {
        try {
          const fh = await tryGet();
          if (fh) {
            const file = await fh.getFile();
            return await fileToDataUrl(file);
          }
        } catch (_e) { /* next */ }
      }
      return null;
    }

    async _getFileByRelativePath(dirHandle, relPath) {
      const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
      let current = dirHandle;
      for (let i = 0; i < parts.length; i++) {
        if (i === parts.length - 1) return await current.getFileHandle(parts[i]);
        current = await current.getDirectoryHandle(parts[i]);
      }
      return null;
    }

    async _getFileInSubdir(dirHandle, subdir, basename) {
      const sub = await dirHandle.getDirectoryHandle(subdir);
      return await sub.getFileHandle(basename);
    }

    _makeRef(path, meta, handleExtra) {
      return {
        id: path,
        path,
        meta,
        sourceKind: 'directory',
        handle: handleExtra,
      };
    }

    /** Find bankRef from scan result by path */
    findBankRef(repoData, path) {
      for (const topics of Object.values(repoData || {})) {
        for (const banks of Object.values(topics)) {
          for (const b of banks) {
            if (b.path === path) return b.bankRef;
          }
        }
      }
      return null;
    }
  }

  // ── Future sources (stubs) ────────────────────────────────────────────────

  // class GitHubSource { ... } — fetch banks from GitHub API / raw URLs
  // class ZipSource { ... } — load banks from uploaded .zip archive

  function autoSelectSource() {
    if (global.__TAURI__) return new TauriSource();
    return new DirectorySource();
  }

  global.EstelaBankSource = {
    SKIP_DIRS,
    SKIP_COURSES,
    getQtype,
    stripTags,
    latexToHtml,
    typeLabel,
    parseYaml,
    isBank,
    bankMeta,
    extractMcAnswers,
    TauriSource,
    DirectorySource,
    autoSelectSource,
  };
})(typeof window !== 'undefined' ? window : globalThis);
