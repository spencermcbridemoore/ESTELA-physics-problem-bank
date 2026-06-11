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

  function buildCategorizationGroups(qdata) {
    const groups = [];
    const cats = Array.isArray(qdata?.categories) ? qdata.categories : [];
    for (const entry of cats) {
      let cat = entry;
      if (cat && typeof cat === 'object' && !Array.isArray(cat)
          && cat.category && typeof cat.category === 'object') {
        cat = cat.category;
      }
      if (!cat || typeof cat !== 'object' || Array.isArray(cat)) continue;
      const items = (Array.isArray(cat.answers) ? cat.answers : [])
        .map((a) => latexToHtml(String(a ?? '')));
      groups.push({
        title: latexToHtml(String(cat.description ?? 'Category')),
        items,
        correct: true,
      });
    }
    const distractors = (Array.isArray(qdata?.distractors) ? qdata.distractors : [])
      .map((a) => latexToHtml(String(a ?? '')));
    if (distractors.length) {
      groups.push({ title: 'Distractors (belong to no category)', items: distractors, correct: false });
    }
    return groups;
  }

  // ── Canvas QTI package helpers ────────────────────────────────────────────

  function qtiZipPreference(filename, bankId) {
    const n = String(filename || '').toLowerCase();
    const id = String(bankId || '').toLowerCase();
    if (id && n === `${id}.zip`) return 0;
    if (n.includes('qti')) return 1;
    if (n === 'import.zip') return 2;
    return 3;
  }

  async function verifyQtiZipBytes(bytes) {
    if (!global.JSZip) return true; // cannot verify without JSZip — assume ok
    try {
      const z = await global.JSZip.loadAsync(bytes);
      return !!z.file('imsmanifest.xml');
    } catch (_e) {
      return false;
    }
  }

  function qtiDownloadName(bankId, originalName) {
    if (bankId) return `${bankId}-canvas-qti.zip`;
    const base = String(originalName || 'qti').replace(/\.zip$/i, '');
    return `${base}-canvas-qti.zip`;
  }

  async function buildQuestionsFromData(data, bankRef, resolveFigureFn) {
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
        const ts = tol ? ` ± ${tol}${mt === 'percent' ? '%' : ''}` : '';
        if (val && val !== 'null') {
          answers.push({ label: 'Answer', text: `${val}${ts}`, correct: true });
        }
      } else if (qtype === 'true_false') {
        const av = !!qdata.answer;
        answers.push({ label: 'Answer', text: av ? 'True' : 'False', correct: true });
      }

      const groups = qtype === 'categorization' ? buildCategorizationGroups(qdata) : null;

      const fb = qdata.feedback || {};
      const solution = latexToHtml(fb.general || '');
      const fig_url = await resolveFigureFn(bankRef, qdata, bankRef);

      questions.push({
        id: qdata.id || `q${questions.length + 1}`,
        title: qdata.title || '',
        type: qtype,
        type_label: typeLabel(qtype),
        body,
        answers,
        groups,
        solution,
        fig_url,
      });
    }
    return questions;
  }

  function bytesToDataUrl(bytes, filename) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const name = (filename || '').toLowerCase();
    let mime = 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
    else if (name.endsWith('.gif')) mime = 'image/gif';
    else if (name.endsWith('.svg')) mime = 'image/svg+xml';
    else if (name.endsWith('.webp')) mime = 'image/webp';
    return `data:${mime};base64,${b64}`;
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
      const questions = result.questions || [];
      const rawQs = Array.isArray(result.rawData?.questions) ? result.rawData.questions : [];
      questions.forEach((q, i) => {
        if (q && q.type === 'categorization') {
          q.groups = buildCategorizationGroups(rawQs[i]?.categorization || {});
        }
      });
      return {
        meta: result.meta,
        rawData: result.rawData,
        questions,
        bankRef: this._makeRef(path, result.meta),
      };
    }

    /** Raw YAML text of the bank file (best effort). */
    async loadBankText(ref) {
      const path = typeof ref === 'string' ? ref : (ref?.path || ref?.handle?.path);
      if (!path || !global.__TAURI__?.core?.convertFileSrc) return null;
      try {
        const url = global.__TAURI__.core.convertFileSrc(path);
        const resp = await fetch(url);
        if (resp.ok) return await resp.text();
      } catch (_e) { /* fall through */ }
      return null;
    }

    /** Canvas QTI package sitting next to the bank file, if any. */
    async getQtiPackage(ref) {
      const path = typeof ref === 'string' ? ref : (ref?.path || ref?.handle?.path);
      if (!path || !global.__TAURI__?.core?.convertFileSrc) return null;
      const bankDir = path.replace(/[/\\][^/\\]+$/, '');
      const bankId = ref?.meta?.bank_id || '';
      const names = [];
      if (bankId) names.push(`${bankId}.zip`);
      names.push('qti_import.zip', 'import.zip', 'qti.zip');
      for (const name of names) {
        try {
          const url = global.__TAURI__.core.convertFileSrc(`${bankDir}/${name}`);
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const bytes = new Uint8Array(await resp.arrayBuffer());
          if (await verifyQtiZipBytes(bytes)) {
            return { bytes, filename: qtiDownloadName(bankId, name) };
          }
        } catch (_e) { /* try next */ }
      }
      return null;
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
        const zipFiles = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
        bankRef.handle.qtiZipFiles = zipFiles;
        bankRef.meta.has_qti = zipFiles.length > 0;
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

    /** Raw YAML text of the bank file. */
    async loadBankText(ref) {
      const fh = ref?.handle?.fileHandle;
      if (!fh) return null;
      const file = await fh.getFile();
      return file.text();
    }

    /** Canvas QTI package sitting next to the bank file, if any. */
    async getQtiPackage(ref) {
      const bankId = ref?.meta?.bank_id || '';
      let candidates = ref?.handle?.qtiZipFiles || [];
      if (!candidates.length && ref?.handle?.bankDirHandle) {
        candidates = [];
        for await (const [name, handle] of ref.handle.bankDirHandle) {
          if (handle.kind === 'file' && name.toLowerCase().endsWith('.zip')) {
            candidates.push({ name, handle });
          }
        }
      }
      const sorted = [...candidates].sort(
        (a, b) => qtiZipPreference(a.name, bankId) - qtiZipPreference(b.name, bankId)
      );
      for (const f of sorted) {
        try {
          const file = await f.handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (await verifyQtiZipBytes(bytes)) {
            return { bytes, filename: qtiDownloadName(bankId, f.name) };
          }
        } catch (_e) { /* next */ }
      }
      return null;
    }

    async _buildQuestions(data, bankRef) {
      return buildQuestionsFromData(data, bankRef, (r, qd, br) => this.resolveFigure(r, qd, br));
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

  // ── ZipSource / BundleSource (in-memory archive) ─────────────────────────

  function detectZipPrefix(paths) {
    if (!paths.length) return '';
    const roots = new Set(paths.map((p) => p.split('/')[0]).filter(Boolean));
    if (roots.size !== 1) return '';
    const root = [...roots][0];
    if (SKIP_COURSES.includes(root)) return '';
    if (root.toLowerCase().includes('estela') || root.endsWith('-main') || root.endsWith('-master')) {
      return `${root}/`;
    }
    return '';
  }

  class ZipSource {
    constructor() {
      this.id = 'zip';
      this.label = 'Zip archive';
      this._zip = null;
      this._prefix = '';
      this._ready = false;
      this._displayName = 'Zip archive';
    }

    getDisplayPath() {
      return this._displayName;
    }

    async loadFromArrayBuffer(buf) {
      if (!global.JSZip) throw new Error('JSZip not loaded');
      this._zip = await global.JSZip.loadAsync(buf);
      const paths = [];
      this._zip.forEach((rel, entry) => {
        if (!entry.dir) paths.push(rel.replace(/\\/g, '/'));
      });
      this._prefix = detectZipPrefix(paths);
      this._ready = true;
    }

    async ensureReady() {
      if (!this._ready) throw new Error('Zip not loaded');
    }

    _zipPath(logicalPath) {
      const p = logicalPath.replace(/\\/g, '/');
      return this._prefix ? this._prefix + p : p;
    }

    _logicalPath(zipRel) {
      const p = zipRel.replace(/\\/g, '/');
      if (this._prefix && p.startsWith(this._prefix)) return p.slice(this._prefix.length);
      return p;
    }

    async _readText(logicalPath) {
      const entry = this._zip.file(this._zipPath(logicalPath));
      if (!entry) return null;
      return entry.async('text');
    }

    async _readBytes(logicalPath) {
      const entry = this._zip.file(this._zipPath(logicalPath));
      if (!entry) return null;
      return entry.async('uint8array');
    }

    _listLogicalPaths() {
      const paths = [];
      this._zip.forEach((rel, entry) => {
        if (!entry.dir) paths.push(this._logicalPath(rel.replace(/\\/g, '/')));
      });
      return paths;
    }

    async scan() {
      await this.ensureReady();
      const paths = this._listLogicalPaths();
      const result = {};
      const courseNames = new Set();
      for (const p of paths) {
        const course = p.split('/')[0];
        if (course) courseNames.add(course);
      }

      for (const courseName of [...courseNames].sort()) {
        if (SKIP_COURSES.includes(courseName) || courseName.startsWith('.')) continue;
        const courseTopics = {};
        const topicNames = new Set();
        for (const p of paths) {
          if (!p.startsWith(`${courseName}/`)) continue;
          const topic = p.split('/')[1];
          if (topic) topicNames.add(topic);
        }

        for (const topicName of [...topicNames].sort()) {
          if (topicName.startsWith('.')) continue;
          const banks = await this._collectBanks(courseName, topicName, paths);
          if (banks.length) courseTopics[topicName] = banks;
        }

        if (Object.keys(courseTopics).length) result[courseName] = courseTopics;
      }

      return { data: result };
    }

    async _collectBanks(courseName, topicName, paths) {
      const prefix = `${courseName}/${topicName}/`;
      const banks = [];
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const ext = p.split('.').pop()?.toLowerCase();
        if (ext !== 'yaml' && ext !== 'yml') continue;
        const relFromTopic = p.slice(prefix.length).split('/');
        if (relFromTopic.some((part) => SKIP_DIRS.includes(part))) continue;

        let content;
        try {
          content = await this._readText(p);
        } catch (_e) {
          continue;
        }
        if (!content) continue;

        let data;
        try {
          data = parseYaml(content);
        } catch (_e) {
          continue;
        }
        if (!isBank(data)) continue;

        const status = data.bank_info?.status || '';
        if (status === 'draft' || status === 'deprecated') continue;

        const bankDirZipPath = p.substring(0, p.lastIndexOf('/') + 1);
        const bankRef = this._makeRef(p, bankMeta(data), { zipPath: p, bankDirZipPath });
        bankRef.meta.has_qti = paths.some(
          (z) => z.startsWith(bankDirZipPath)
            && z.toLowerCase().endsWith('.zip')
            && !z.slice(bankDirZipPath.length).includes('/')
        );
        banks.push({ path: p, meta: bankRef.meta, bankRef });
      }
      banks.sort((a, b) => a.path.localeCompare(b.path));
      return banks;
    }

    async loadBank(ref) {
      const bankRef = ref?.handle?.zipPath ? ref : null;
      if (!bankRef?.handle?.zipPath) throw new Error('Invalid bank reference for zip source');
      await this.ensureReady();
      const content = await this._readText(bankRef.handle.zipPath);
      if (!content) throw new Error('Failed to read bank from zip');
      const data = parseYaml(content);
      if (!isBank(data)) throw new Error('Invalid bank');
      const meta = bankMeta(data);
      const questions = await buildQuestionsFromData(
        data, bankRef, (r, qd, br) => this.resolveFigure(r, qd, br)
      );
      return { meta, rawData: data, questions, bankRef };
    }

    /** Raw YAML text of the bank file. */
    async loadBankText(ref) {
      const zipPath = ref?.handle?.zipPath;
      if (!zipPath) return null;
      await this.ensureReady();
      return this._readText(zipPath);
    }

    /** Canvas QTI package sitting next to the bank file, if any. */
    async getQtiPackage(ref) {
      const bankRef = ref?.handle?.zipPath ? ref : null;
      if (!bankRef) return null;
      await this.ensureReady();
      const bankDir = bankRef.handle.bankDirZipPath || '';
      const bankId = bankRef.meta?.bank_id || '';
      const candidates = this._listLogicalPaths()
        .filter((p) => p.startsWith(bankDir)
          && p.toLowerCase().endsWith('.zip')
          && !p.slice(bankDir.length).includes('/'))
        .sort((a, b) => qtiZipPreference(a.split('/').pop(), bankId)
          - qtiZipPreference(b.split('/').pop(), bankId));
      for (const p of candidates) {
        try {
          const bytes = await this._readBytes(p);
          if (bytes && await verifyQtiZipBytes(bytes)) {
            return { bytes, filename: qtiDownloadName(bankId, p.split('/').pop()) };
          }
        } catch (_e) { /* next */ }
      }
      return null;
    }

    async resolveFigure(_ref, qdata, bankRef) {
      const fig = qdata?.figure;
      const bankDir = bankRef?.handle?.bankDirZipPath;
      if (!fig || !bankDir) return null;
      const basename = fig.replace(/\\/g, '/').split('/').pop();
      const candidates = [
        `${bankDir}${fig.replace(/\\/g, '/')}`,
        `${bankDir}Figures/${basename}`,
        `${bankDir}Figure/${basename}`,
        `${bankDir}figures/${basename}`,
        `${bankDir}figure/${basename}`,
        `${bankDir}Images/${basename}`,
        `${bankDir}images/${basename}`,
      ];
      for (const path of candidates) {
        try {
          const bytes = await this._readBytes(path);
          if (bytes) return bytesToDataUrl(bytes, basename);
        } catch (_e) { /* next */ }
      }
      return null;
    }

    _makeRef(path, meta, handleExtra) {
      return {
        id: path,
        path,
        meta,
        sourceKind: 'zip',
        handle: handleExtra,
      };
    }

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

  class BundleSource extends ZipSource {
    constructor() {
      super();
      this.id = 'bundle';
      this.label = global.__ESTELA_BUNDLE__?.label || 'Bundled banks';
      this._displayName = this.label;
    }

    async ensureReady() {
      if (this._ready) return;
      const bundle = global.__ESTELA_BUNDLE__;
      if (!bundle?.zipBase64) throw new Error('No embedded bundle');
      const binary = atob(bundle.zipBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await this.loadFromArrayBuffer(bytes.buffer);
    }
  }

  // class GitHubSource { ... } — fetch banks from GitHub API / raw URLs

  function autoSelectSource() {
    if (global.__ESTELA_BUNDLE__) return new BundleSource();
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
    buildCategorizationGroups,
    TauriSource,
    DirectorySource,
    ZipSource,
    BundleSource,
    autoSelectSource,
  };
})(typeof window !== 'undefined' ? window : globalThis);
