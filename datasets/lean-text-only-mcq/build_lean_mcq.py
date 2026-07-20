#!/usr/bin/env python3
"""
Extract the "lean" text-only, single-answer multiple-choice questions from the
ESTELA physics problem bank into structured JSONL + CSV for MCQ logprob work.

Read-only w.r.t. the repo: reads the 5 source YAML banks, writes ONLY into
scratch/lean_mcq/. Re-runnable. Edit LEAN_BANKS to add/remove banks
(e.g. append VASTV if you decide the figure is redundant there).
"""
import os, re, json, csv, html, sys, random, hashlib
import yaml

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT  = os.path.dirname(os.path.abspath(__file__))

# The 5 figure-free, 100%-single-answer-MCQ banks (the "~100 lean" set = 95 Qs).
LEAN_BANKS = [
    "PHY I Mechanics/11_Simple Harmonic Motion/PHY1-SMH-MESHM-12012025/PHY1-SMH-MESHM-12012025.yaml",
    "PHY I Mechanics/3_Forces/PHY1-F-N2LCQELEV-100925/PHY1-F-N2LCQELEV-100925.yml",
    "PHY I Mechanics/3_Forces/PHY1-F-SFMC-09162025/PHY1-F-SFMC-09162025.yaml",
    "PHY I Mechanics/4_Newton's Laws of Motion/PHY1-N-DACCFMC-10082025/PHY1-N-DACCFMC-10082025.yml",
    "PHY I Mechanics/5_Kinetic Energy and Work/PHY1-F-CWDVF-10052025/PHY1-F-CWDVF-10052025.yaml",
]
LABELS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def latexify(s: str) -> str:
    def repl(m):
        inner = re.sub(r"\s+", " ", m.group(1).strip())
        return f"${inner}$"
    return re.sub(r"<latex>(.*?)</latex>", repl, s, flags=re.S | re.I)


def clean(s) -> str:
    if s is None:
        return ""
    s = latexify(str(s))
    s = re.sub(r"<\s*/?\s*ul\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<\s*li\s*>", "\n- ", s, flags=re.I)
    s = re.sub(r"<\s*/\s*li\s*>", "", s, flags=re.I)
    s = re.sub(r"<\s*br\s*/?\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)            # strip any remaining tags
    s = html.unescape(s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def truthy(v) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def unit_of(relpath: str) -> str:
    parts = relpath.replace("\\", "/").split("/")
    return parts[1] if len(parts) > 1 else ""


def load_bank(path, rel):
    """Tolerant loader: metadata via regex over the header, questions via a
    YAML parse of the sliced `questions:` block. This isolates the questions
    from any malformed `bank_info` (several source files have indentation bugs
    that strict YAML rejects)."""
    raw = open(path, encoding="utf-8", errors="replace").read()
    qm = re.search(r"(?m)^questions:\s*$", raw)
    header = raw[: qm.start()] if qm else raw
    qblock = raw[qm.start():] if qm else "questions: []"

    def find(key):
        m = re.search(rf"(?m)^\s*{key}:\s*(.+?)\s*(?:#.*)?$", header)
        return m.group(1).strip() if m else ""

    bank_id = find("bank_id") or os.path.splitext(os.path.basename(rel))[0]
    bank_title = find("title")
    los = []
    lm = re.search(r"(?m)^\s*learning[_ ]objectives?:", header)
    if lm:
        for line in header[lm.end():].splitlines():
            mm = re.match(r"^\s+-\s*([A-Za-z0-9][\w./-]*)\s*(?:#.*)?$", line)
            if mm:
                los.append(mm.group(1))
            elif line.strip():
                break

    warn = None
    try:
        d = yaml.safe_load(qblock)
        questions = (d or {}).get("questions") or []
    except yaml.YAMLError as e:
        questions, warn = [], str(e).splitlines()[0]
    return bank_id, bank_title, los, questions, warn


records, problems, warnings = [], 0, []
for rel in LEAN_BANKS:
    path = os.path.join(REPO, rel)
    bank_id, bank_title, los, questions, warn = load_bank(path, rel)
    if warn:
        warnings.append((rel, warn))
    for item in questions:
        if not isinstance(item, dict) or "multiple_choice" not in item:
            continue
        q = item["multiple_choice"]
        opts = [a.get("answer", {}) for a in (q.get("answers") or []) if isinstance(a, dict)]
        flags = []
        correct_idx = [i for i, o in enumerate(opts) if truthy(o.get("correct"))]
        if len(correct_idx) == 1:
            ai = correct_idx[0]
        elif not correct_idx and any("points" in o for o in opts):
            ai = max(range(len(opts)), key=lambda i: opts[i].get("points", 0))
            flags.append("variable_points")
        elif len(correct_idx) > 1:
            ai = correct_idx[0]; flags.append("multiple_correct")
        else:
            ai = None; flags.append("no_single_correct")
        if any(truthy(o.get("lock")) for o in opts):
            flags.append("has_locked_option")

        choices = [clean(o.get("text")) for o in opts]
        choices_raw = [str(o.get("text", "")).strip() for o in opts]
        norm = [re.sub(r"\s+", "", c) for c in choices]
        if len(set(norm)) != len(norm):
            flags.append("duplicate_choices")

        # Deterministic per-question shuffle (seed from uid) to defeat the
        # strong position bias: 70/95 correct answers are at position A in the
        # source. perm[new] = old_index.
        uid = f"{bank_id}::{q.get('id','')}"
        seed = int(hashlib.sha256(uid.encode()).hexdigest()[:8], 16)
        perm = list(range(len(opts)))
        random.Random(seed).shuffle(perm)
        choices_shuf = [choices[i] for i in perm]
        ai_shuf = perm.index(ai) if ai is not None else None

        rec = {
            "uid": f"{bank_id}::{q.get('id','')}",
            "bank_id": bank_id,
            "bank_title": bank_title,
            "unit": unit_of(rel),
            "learning_objectives": los,
            "source_file": rel.replace("\\", "/"),
            "source_qid": q.get("id", ""),
            "title": str(q.get("title", "")).strip(),
            "points": q.get("points", 1),
            "has_figure": "figure" in q and bool(q.get("figure")),
            "num_choices": len(opts),
            "labels": LABELS[: len(opts)],
            "question": clean(q.get("text")),
            "question_raw": (q.get("text") or "").strip(),
            "choices": choices,
            "choices_raw": choices_raw,
            "answer_index": ai,
            "answer_label": LABELS[ai] if ai is not None else None,
            "answer_text": choices[ai] if ai is not None else None,
            # de-biased ordering (use these to avoid the always-A artifact)
            "shuffle_perm": perm,
            "choices_shuffled": choices_shuf,
            "answer_index_shuffled": ai_shuf,
            "answer_label_shuffled": LABELS[ai_shuf] if ai_shuf is not None else None,
            "format_flags": flags,
        }
        records.append(rec)
        problems += 1

# ---- write JSONL ----
jsonl = os.path.join(OUT, "estela_text_only_mcq.jsonl")
with open(jsonl, "w", encoding="utf-8") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

# ---- write CSV (flattened, choices single-line) ----
maxc = max(r["num_choices"] for r in records)
csvp = os.path.join(OUT, "estela_text_only_mcq.csv")
with open(csvp, "w", encoding="utf-8", newline="") as f:
    cols = (["uid", "bank_id", "unit", "learning_objectives", "title", "points",
             "question"] + [f"choice_{LABELS[i]}" for i in range(maxc)]
            + ["answer_label", "num_choices", "format_flags", "source_file", "source_qid"])
    w = csv.writer(f)
    w.writerow(cols)
    for r in records:
        oneline = lambda s: re.sub(r"\s*\n\s*", " ", s).strip()
        # CSV presents the de-biased shuffled order; answer_label matches it.
        row = [r["uid"], r["bank_id"], r["unit"], "|".join(r["learning_objectives"]),
               r["title"], r["points"], oneline(r["question"])]
        for i in range(maxc):
            row.append(oneline(r["choices_shuffled"][i]) if i < r["num_choices"] else "")
        row += [r["answer_label_shuffled"], r["num_choices"], "|".join(r["format_flags"]),
                r["source_file"], r["source_qid"]]
        w.writerow(row)

# ---- console summary ----
from collections import Counter
bybank = Counter(r["bank_id"] for r in records)
nc = Counter(r["num_choices"] for r in records)
flg = Counter(x for r in records for x in r["format_flags"])
print(f"Extracted {problems} single-answer MCQ from {len(LEAN_BANKS)} banks")
for b, n in bybank.items():
    print(f"  {b:32} {n}")
print("choices/question:", dict(sorted(nc.items())))
print("with a resolved single correct answer:",
      sum(1 for r in records if r["answer_index"] is not None), "/", problems)
print("format_flags:", dict(flg) or "none")
if warnings:
    print("PARSE WARNINGS:")
    for rel, w in warnings:
        print(f"  {os.path.basename(rel)}: {w}")
print("wrote:", os.path.relpath(jsonl, REPO))
print("wrote:", os.path.relpath(csvp, REPO))
