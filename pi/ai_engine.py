"""
S.py on-device AI. Everything here runs on the Pi — no cloud AI.

  eco_ink_pdf / eco_ink_image   free toner saver (dark slides, shadowed scans, tinted pages)
  green_ai_compress             crop margins + reflow content into fewer A4 pages
  make_summary                  RAG + small language model -> 1-page cheat sheet / exactly-3-page summary
  Telemetry                     live per-core CPU stats written to the job row for the kiosk's monitor
"""

import html
import io
import json
import math
import os
import re
import threading
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path

import cv2
import numpy as np
import psutil
import requests

try:
    import pymupdf as fitz
except ImportError:  # PyMuPDF < 1.24.3
    import fitz

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph

OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:0.5b")
NCPU = os.cpu_count() or 1
AI_CORES = set(range(1, NCPU)) if NCPU >= 4 else set(range(NCPU))  # leave core 0 for printing/heartbeat

PAGE_W, PAGE_H = A4  # points


# ---------------------------------------------------------------- runtime helpers

def slm_available() -> bool:
    """True if Ollama is up and the model is pulled."""
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=2)
        names = [m.get("name", "") for m in r.json().get("models", [])]
        return MODEL in names
    except Exception:
        return False


@contextmanager
def pinned_cores(cores=AI_CORES):
    """Pin the calling thread (Linux) so AI work stays off core 0."""
    try:
        previous = os.sched_getaffinity(0)
    except AttributeError:
        yield
        return
    target = set(cores) & set(range(NCPU))
    cv2.setNumThreads(max(1, len(target)))
    try:
        if target:
            os.sched_setaffinity(0, target)
        yield
    finally:
        os.sched_setaffinity(0, previous)
        cv2.setNumThreads(NCPU)


class Telemetry:
    """Samples real CPU/temp/memory once a second and writes it to print_jobs.ai_telemetry."""

    def __init__(self, client, job_id: str, interval: float = 1.0):
        self.client, self.job_id, self.interval = client, job_id, interval
        self._stage, self._progress = "Starting", 0.0
        self._started = time.time()
        self._stop = threading.Event()
        self._thread = None

    def stage(self, text: str, progress: float | None = None):
        self._stage = text
        if progress is not None:
            self._progress = max(0.0, min(1.0, progress))

    def snapshot(self) -> dict:
        freq = psutil.cpu_freq()
        temp = None
        try:
            temps = psutil.sensors_temperatures()
            for key in ("cpu_thermal", "cpu-thermal", "coretemp"):
                if temps.get(key):
                    temp = round(temps[key][0].current, 1)
                    break
        except Exception:
            pass
        return {
            "cpu": [round(c, 1) for c in psutil.cpu_percent(percpu=True)],
            "freq_mhz": round(freq.current) if freq else None,
            "temp_c": temp,
            "mem_pct": round(psutil.virtual_memory().percent, 1),
            "stage": self._stage,
            "progress": round(self._progress, 3),
            "started_at": int(self._started * 1000),
        }

    def _run(self):
        self._stop.wait(0.4)
        while not self._stop.is_set():
            try:
                (self.client.table("print_jobs").update({"ai_telemetry": self.snapshot()})
                 .eq("id", self.job_id).eq("status", "COUNTING").execute())
            except Exception:
                pass
            self._stop.wait(self.interval)

    def __enter__(self):
        psutil.cpu_percent(percpu=True)  # prime the counters
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)


def _note(tele, text, progress=None):
    if tele:
        tele.stage(text, progress)


# ---------------------------------------------------------------- eco-ink

from ink import eco_ink_gray, page_needs_eco as _page_needs_eco  # shared with the upload inspector


def _ink(gray: np.ndarray) -> float:
    return float((255 - gray).mean()) / 255.0


def _gray_pixmap(page, dpi):
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w).copy()


def eco_ink_pdf(src: Path, dst: Path, tele=None) -> dict | None:
    """Re-renders only pages that need it. Returns stats, or None if nothing needed treating (dst not written)."""
    doc = fitz.open(src)
    n = doc.page_count
    treat, before, after = [], 0.0, 0.0
    for i in range(n):
        g = _gray_pixmap(doc[i], 72)
        if _page_needs_eco(g):
            treat.append(i)
        else:
            before += _ink(g)
            after += _ink(g)
    if not treat:
        return None
    out = fitz.open()
    for i in range(n):
        page = doc[i]
        if i in treat:
            g = _gray_pixmap(page, 150)
            e = eco_ink_gray(g)
            before += _ink(g)
            after += _ink(e)
            ok, png = cv2.imencode(".png", e)
            new = out.new_page(width=page.rect.width, height=page.rect.height)
            new.insert_image(new.rect, stream=png.tobytes())
        else:
            out.insert_pdf(doc, from_page=i, to_page=i)
        _note(tele, f"Eco-ink page {i + 1}/{n}", (i + 1) / n)
    out.save(dst, garbage=3, deflate=True)
    saved = 0.0 if before <= 0 else 100.0 * (1.0 - after / before)
    return {"pages_treated": len(treat), "ink_saved_pct": round(max(0.0, saved), 1)}


def eco_ink_image(src: Path, dst: Path) -> dict:
    img = cv2.imread(str(src), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise RuntimeError("Could not read image for eco-ink")
    longest = max(img.shape)
    if longest > 3600:  # A4 at ~300 dpi is plenty
        f = 3600 / longest
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    out = eco_ink_gray(img)
    cv2.imwrite(str(dst), out)
    before, after = _ink(img), _ink(out)
    return {"ink_saved_pct": round(max(0.0, 100.0 * (1.0 - after / before)) if before > 0 else 0.0, 1)}


# ---------------------------------------------------------------- Green AI (crop + reflow)

MARGIN = 22.0
SPLIT_GAP = 5       # blank rows (pt) that allow a cut
PAGE_GAP = 10.0     # space between source pages after reflow
INK_DELTA = 40


def _bounds(gray):
    bg = int(np.median(gray))
    mask = np.abs(gray.astype(np.int16) - bg) > INK_DELTA
    rows, cols = mask.sum(axis=1) >= 2, mask.sum(axis=0) >= 2
    ys, xs = np.where(rows)[0], np.where(cols)[0]
    if len(ys) == 0 or len(xs) == 0:
        return None
    return xs[0], ys[0], xs[-1] + 1, ys[-1] + 1, rows


def _blocks(rows, y0, y1):
    blocks, start, gap, last = [], y0, 0, y0
    for y in range(y0, y1):
        if rows[y]:
            if gap >= SPLIT_GAP:
                blocks.append((start, last + 1))
                start = y
            gap, last = 0, y
        else:
            gap += 1
    blocks.append((start, last + 1))
    return blocks


def green_ai_compress(src: Path, dst: Path, tele=None) -> dict:
    """Crops whitespace and reflows page content onto fewer A4 pages (vector content is preserved)."""
    doc = fitz.open(src)
    n = doc.page_count
    if any(p.rotation for p in doc):
        return {"pages": n, "note": "Rotated pages aren't supported by Green AI — printing as-is."}

    entries, blank = [], 0
    for i in range(n):
        page = doc[i]
        g = _gray_pixmap(page, 72)
        sx, sy = page.rect.width / g.shape[1], page.rect.height / g.shape[0]
        b = _bounds(g)
        if b is None:
            blank += 1
        else:
            x0, y0, x1, y1, rows = b
            entries.append({"pno": i, "x0": x0 * sx, "x1": x1 * sx,
                            "blocks": [(a * sy, c * sy) for a, c in _blocks(rows, y0, y1)]})
        _note(tele, f"Scanning page {i + 1}/{n} for whitespace", 0.55 * (i + 1) / n)
    if not entries:
        return {"pages": n, "note": "No printable content found."}

    gx0 = float(np.percentile([e["x0"] for e in entries], 10))
    gx1 = float(np.percentile([e["x1"] for e in entries], 90))
    usable_w, usable_h = PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN

    out = fitz.open()
    page, y = None, MARGIN

    def fresh():
        nonlocal page, y
        page, y = out.new_page(width=PAGE_W, height=PAGE_H), MARGIN

    for k, e in enumerate(entries):
        px0, px1 = max(0.0, min(e["x0"], gx0) - 2), max(e["x1"], gx1) + 2
        scale = min(1.0, usable_w / (px1 - px0))
        blocks, i = e["blocks"], 0
        while i < len(blocks):
            if page is None:
                fresh()
            space = PAGE_H - MARGIN - y
            j = i
            while j < len(blocks) and (blocks[j][1] - blocks[i][0]) * scale <= space:
                j += 1
            local = scale
            if j == i:
                if y > MARGIN + 0.5:
                    fresh()
                    continue
                local = min(scale, space / (blocks[i][1] - blocks[i][0]))
                j = i + 1
            ya, yb = max(0.0, blocks[i][0] - 2), blocks[j - 1][1] + 2
            h = (yb - ya) * local
            if i == 0 and y > MARGIN + 1:  # hairline marking where an original page began
                line_y = y - PAGE_GAP / 2
                page.draw_line((MARGIN, line_y), (PAGE_W - MARGIN, line_y), color=(0.75, 0.75, 0.75), width=0.5)
            rect = fitz.Rect(MARGIN, y, MARGIN + (px1 - px0) * local, y + h)
            page.show_pdf_page(rect, doc, e["pno"], clip=fitz.Rect(px0, ya, px1, yb))
            y += h
            i = j
            if i < len(blocks):
                page = None
        y += PAGE_GAP
        _note(tele, f"Reflowing content ({k + 1}/{len(entries)})", 0.55 + 0.45 * (k + 1) / len(entries))

    new_pages = out.page_count
    if new_pages >= n:
        return {"pages": n, "note": "This document is already compact — no saving possible."}
    out.save(dst, garbage=3, deflate=True)
    note = f"{n} → {new_pages} pages"
    if blank:
        note += f" (removed {blank} blank page{'s' if blank != 1 else ''})"
    return {"pages": new_pages, "note": note}


# ---------------------------------------------------------------- RAG

STOP = set("""a about above after again all also am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is
it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the
their them then there these they this those through to too under until up very was we were what when where which while who whom why
will with would you your also may might shall one two thus hence however therefore etc fig figure table""".split())

WORD = re.compile(r"[a-zA-Z]{3,}")
_CP1252_MAP = {"\u2022": "-", "\u2192": "->", "\u2190": "<-", "\u2212": "-", "\u00a0": " ", "\u2009": " ", "\u200b": ""}


def _latin(text: str) -> str:
    for k, v in _CP1252_MAP.items():
        text = text.replace(k, v)
    return text.encode("cp1252", "replace").decode("cp1252")


def _terms(text):
    return [w for w in WORD.findall(text.lower()) if w not in STOP]


def read_pages(doc, pages):
    out = []
    for p in pages:
        t = re.sub(r"\s+", " ", doc[p - 1].get_text("text")).strip()
        if t:
            out.append((p, t))
    return out


def _check_text(page_texts):
    joined = " ".join(t for _, t in page_texts)
    if len(joined.split()) < 60:
        raise ValueError("No readable text found in these pages (scanned/image-only documents can't be summarised yet).")
    letters = [c for c in joined if c.isalpha()]
    if letters and sum(ord(c) > 0x024F for c in letters) / len(letters) > 0.2:
        raise ValueError("AI summaries currently support English-language documents only.")
    return joined


def make_chunks(page_texts, size=140, step=110):
    chunks = []
    for p, t in page_texts:
        words = t.split()
        for i in range(0, max(1, len(words)), step):
            piece = words[i:i + size]
            if len(piece) >= 15:
                chunks.append({"page": p, "text": " ".join(piece)})
    return chunks


def _tfidf(chunks):
    docs = [Counter(_terms(c["text"])) for c in chunks]
    df = Counter(t for d in docs for t in d)
    n = len(docs)
    idf = {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}
    return docs, idf


def _vec(counter, idf):
    return {t: tf * idf.get(t, 1.0) for t, tf in counter.items()}


def _cos(a, b):
    num = sum(v * b.get(k, 0.0) for k, v in a.items())
    den = math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values()))
    return num / den if den else 0.0


QUERY = "key concepts definitions formulas principles methods results conclusions summary important"


def rank_chunks(chunks):
    """Chunks ordered by relevance to a generic 'what matters' query (TF-IDF cosine)."""
    docs, idf = _tfidf(chunks)
    q = _vec(Counter(_terms(QUERY)), idf)
    scores = [_cos(_vec(d, idf), q) for d in docs]
    return [chunks[i] for i in sorted(range(len(chunks)), key=lambda i: -scores[i])]


def diverse_context(ranked, chunks, k):
    """Best chunk from each of k equal slices of the document, so the SLM sees the whole range."""
    if len(chunks) <= k:
        return list(chunks)
    order = {id(c): i for i, c in enumerate(chunks)}
    best = {}
    for c in ranked:
        slot = min(k - 1, order[id(c)] * k // len(chunks))
        best.setdefault(slot, c)
    return sorted(best.values(), key=lambda c: order[id(c)])


def slm_generate(prompt, max_tokens, tele=None, label="Generating"):
    payload = {"model": MODEL, "prompt": prompt, "stream": True, "keep_alive": "30m",
               "options": {"temperature": 0.2, "num_predict": max_tokens, "num_ctx": 3072,
                           "num_thread": max(1, len(AI_CORES))}}
    parts, count = [], 0
    try:
        with requests.post(f"{OLLAMA_BASE}/api/generate", json=payload, stream=True, timeout=(5, 180)) as r:
            if r.status_code >= 400:  # Ollama explains itself in the body (e.g. "requires more system memory")
                detail = r.text.strip()[:300]
                print(f"[ollama] HTTP {r.status_code}: {detail}")
                low = detail.lower()
                if "memory" in low:
                    raise RuntimeError("The printer doesn't have enough free memory for the AI engine right now. Please try again in a minute.")
                if "not found" in low or "pull" in low:
                    raise RuntimeError("The AI model isn't installed on this printer yet.")
                raise RuntimeError(f"The AI engine returned an error ({r.status_code}).")
            for line in r.iter_lines():
                if not line:
                    continue
                d = json.loads(line)
                parts.append(d.get("response", ""))
                count += 1
                if tele and count % 4 == 0:
                    tele.stage(f"{label} ({MODEL})", 0.15 + 0.8 * min(1.0, count / max_tokens))
                if d.get("done"):
                    break
    except requests.RequestException as e:
        raise RuntimeError(f"AI engine (Ollama) isn't responding: {e.__class__.__name__}") from e
    return "".join(parts).strip()


BULLET = re.compile(r"^\s*(?:[-*\u2022]|\d{1,2}[.)])\s+(.*\S)\s*$")


def parse_bullets(text, limit):
    out = []
    for line in text.splitlines():
        m = BULLET.match(line)
        if m:
            s = re.sub(r"\*\*|__", "", m.group(1)).strip()
            s = re.sub(r"^(?:[-*\u2022]\s*)+", "", s)  # models sometimes echo the pre-filled "- "
            if len(s.split()) >= 4:
                out.append(s)
        if len(out) >= limit:
            break
    return out


def grounding_score(ai_text: str, source_text: str) -> float:
    """Share of the AI-written text's key terms (4+ letters, non-stopword) that occur in the source."""
    own = {w for w in _terms(ai_text) if len(w) >= 4}
    if not own:
        return 0.0
    src = set(_terms(source_text))
    return round(100.0 * len(own & src) / len(own), 1)


def sentences(page_texts):
    out = []
    for p, t in page_texts:
        for s in re.split(r"(?<=[.!?])\s+", t):
            if 6 <= len(s.split()) <= 38:
                out.append((p, s.strip()))
    return out


def key_terms(chunks, sents, limit=14):
    docs, idf = _tfidf(chunks)
    totals = Counter()
    for d in docs:
        totals.update(d)
    cand = [(t, f * idf.get(t, 1.0)) for t, f in totals.items() if len(t) >= 5 and f >= 2]
    out, used = [], set()
    for term, _ in sorted(cand, key=lambda x: -x[1]):
        hits = [(p, s) for p, s in sents if re.search(rf"\b{re.escape(term)}\b", s, re.I) and s not in used]
        if hits:
            p, s = min(hits, key=lambda x: len(x[1]))
            used.add(s)
            out.append((term, s, p))
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- PDF layout (exact 1 / 3 pages)

def _styles(fs):
    base = dict(fontName="Helvetica", fontSize=fs, leading=fs * 1.32, textColor=colors.HexColor("#111111"))
    return {
        "body": ParagraphStyle("body", spaceAfter=fs * 0.32, **base),
        "bullet": ParagraphStyle("bullet", leftIndent=fs * 0.9, bulletIndent=0, spaceAfter=fs * 0.28, **base),
        "h": ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=fs + 2.2, leading=(fs + 2.2) * 1.25,
                            spaceBefore=fs * 0.7, spaceAfter=fs * 0.35, textColor=colors.HexColor("#0b3d91")),
        "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=fs + 6, leading=(fs + 6) * 1.2,
                                spaceAfter=2, textColor=colors.black),
        "meta": ParagraphStyle("meta", fontName="Helvetica-Oblique", fontSize=max(6.5, fs - 2), leading=fs * 1.2,
                               textColor=colors.HexColor("#555555"), spaceAfter=fs * 0.5),
    }


def _esc(text):
    text = html.escape(_latin(text))
    text = re.sub(r"\[p\.(\d+)\]", r'<font color="#888888" size="7">[p.\1]</font>', text)
    return text


def _flow(kind, text, st):
    if kind == "bullet":
        return Paragraph(_esc(text), st["bullet"], bulletText="\u2022")
    return Paragraph(_esc(text), st[kind])


def _height(flows, width):
    total = 0.0
    for f in flows:
        _, h = f.wrap(width, 10_000)
        total += h + f.getSpaceBefore() + f.getSpaceAfter()
    return total


def _pages_in(pdf_bytes):
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    n = d.page_count
    d.close()
    return n


def _build(story, columns=1, margin=30):
    buf = io.BytesIO()
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=margin, rightMargin=margin, topMargin=margin, bottomMargin=margin,
                          title="S.py AI summary", author="S.py Printer World")
    w, h = PAGE_W - 2 * margin, PAGE_H - 2 * margin
    gutter = 14
    cw = (w - gutter * (columns - 1)) / columns
    frames = [Frame(margin + i * (cw + gutter), margin, cw, h, leftPadding=0, rightPadding=0, topPadding=0,
                    bottomPadding=0, id=f"f{i}") for i in range(columns)]
    doc.addPageTemplates([PageTemplate(id="p", frames=frames)])
    doc.build(story)
    return buf.getvalue()


def build_cheatsheet_pdf(title, meta, bullets, terms):
    margin, gutter = 28, 14
    colw = (PAGE_W - 2 * margin - gutter) / 2
    avail = (PAGE_H - 2 * margin) * 2 * 0.90  # two columns, conservative for column-break waste
    bullets, terms = list(bullets), list(terms)
    for _ in range(40):
        for fs in (10.5, 10, 9.5, 9, 8.5, 8, 7.5):
            st = _styles(fs)
            head = [_flow("title", title, st), _flow("meta", meta, st)]
            body = [_flow("h", "Key points", st)] + [_flow("bullet", b, st) for b in bullets]
            if terms:
                body += [_flow("h", "Key terms", st)] + [_flow("bullet", f"{t.title()}: {s} [p.{p}]", st) for t, s, p in terms]
            if _height(head + body, colw) <= avail:
                pdf = _build(head + body, columns=2, margin=margin)
                if _pages_in(pdf) == 1:
                    return pdf
        if terms:
            terms.pop()
        elif len(bullets) > 3:
            bullets.pop()
        else:
            break
    raise RuntimeError("Could not fit the cheat sheet on one page")


def build_summary_pdf(title, meta, overview, takeaways, passages, terms, formulas):
    margin = 30
    w = PAGE_W - 2 * margin
    for shrink in (0.985, 0.94, 0.90, 0.85):
        avail = (PAGE_H - 2 * margin) * shrink

        # page 1: AI-written overview + takeaways
        take = list(takeaways)
        p1 = None
        while True:
            for fs in (11, 10.5, 10, 9.5, 9, 8.5):
                st = _styles(fs)
                flows = [_flow("title", title, st), _flow("meta", meta, st), _flow("h", "Executive overview", st),
                         _flow("body", overview, st), _flow("h", "Key takeaways", st)] + [_flow("bullet", t, st) for t in take]
                if _height(flows, w) <= avail:
                    p1 = flows
                    break
            if p1 or len(take) <= 2:
                break
            take.pop()
        if p1 is None:
            continue

        st = _styles(10)
        # verbatim excerpts (most relevant first) fill whatever room page 1 has left, then page 2
        remaining = list(passages)

        def take_excerpts(lead_flows, header):
            picked = []
            while remaining:
                trial = sorted(picked + [remaining[0]], key=lambda x: x[0])
                flows = lead_flows + [_flow("h", header, st)] + [_flow("bullet", f"{t} [p.{p}]", st) for p, t in trial]
                if _height(flows, w) > avail:
                    break
                picked = trial
                remaining.pop(0)
            return [_flow("bullet", f"{t} [p.{p}]", st) for p, t in picked]

        extra1 = take_excerpts(p1, "Supporting excerpts from your document")
        if extra1:
            p1 = p1 + [_flow("h", "Supporting excerpts from your document", st)] + extra1
        p2 = [_flow("title", "More excerpts from your document", st),
              _flow("meta", "Verbatim text, most relevant first, in page order", st)]
        extra2 = take_excerpts(p2, "Excerpts")
        p2 = p2 + extra2
        if not extra2:
            p2.append(_flow("body", "This document is short - its key content is already on page 1.", st))

        # page 3: key terms, then formulas / figures
        items = [("t", x) for x in terms] + [("f", x) for x in formulas]
        shown = []
        for it in items:
            trial = shown + [it]
            flows = [_flow("title", "Key terms and figures", st)] + _p3_flows(trial, st)
            if _height(flows, w) > avail:
                break
            shown = trial
        p3 = [_flow("title", "Key terms and figures", st)] + _p3_flows(shown, st)
        if not shown:
            p3.append(_flow("body", "No repeated technical terms were found in the selected pages.", st))

        pdf = _build(p1 + [PageBreak()] + p2 + [PageBreak()] + p3, margin=margin)
        if _pages_in(pdf) == 3:
            return pdf
    raise RuntimeError("Could not lay out the summary on exactly 3 pages")


def _p3_flows(items, st):
    flows, seen_formula = [], False
    for kind, x in items:
        if kind == "t":
            term, s, p = x
            flows.append(_flow("bullet", f"{term.title()}: {s} [p.{p}]", st))
        else:
            if not seen_formula:
                flows.append(_flow("h", "Formulas and figures spotted", st))
                seen_formula = True
            p, s = x
            flows.append(_flow("bullet", f"{s} [p.{p}]", st))
    return flows


# ---------------------------------------------------------------- summaries

def _context_block(chunks):
    return "\n".join(f"[p.{c['page']}] {c['text']}" for c in chunks)


def _extractive_points(ctx, limit, max_words=24):
    """Fallback when the small model's output is unusable: the key sentences themselves, each cited. Never invents anything."""
    out = []
    for c in ctx:
        for sent in re.split(r"(?<=[.!?])\s+", c["text"]):
            w = sent.split()
            if 7 <= len(w) <= 40:
                out.append(f"{' '.join(w[:max_words])}{'...' if len(w) > max_words else ''} [p.{c['page']}]")
                break
        if len(out) >= limit:
            break
    return out


def _extractive_overview(ctx, words=110):
    text = " ".join(c["text"] for c in ctx[:3])
    return " ".join(text.split()[:words]) + "..."


def make_summary(mode: str, src: Path, pages: list[int], dst: Path, title: str, tele=None) -> dict:
    """mode: 'CHEATSHEET' (exactly 1 page) or 'EXECSUM' (exactly 3 pages). Returns {'pages','score','note'}."""
    _note(tele, "Reading your document", 0.03)
    doc = fitz.open(src)
    page_texts = read_pages(doc, pages)
    source_text = _check_text(page_texts)
    chunks = make_chunks(page_texts)
    ranked = rank_chunks(chunks)
    _note(tele, f"Retrieving the most relevant passages from {len(chunks)} chunks", 0.08)

    short_title = _latin(title)[:60]
    span = f"pages {pages[0]}-{pages[-1]}" if len(pages) > 1 else f"page {pages[0]}"

    if mode == "CHEATSHEET":
        ctx = diverse_context(ranked, chunks, 4)
        prompt = ("You are a careful study assistant. Using ONLY the excerpts below, write a cheat sheet.\n"
                  "Rules: at most 14 bullet points, each starting with '- ', each under 22 words, end each bullet with its "
                  "page like [p.3]. Do not add facts that are not in the excerpts.\n\nEXCERPTS:\n"
                  f"{_context_block(ctx)}\n\nCHEAT SHEET:\n- ")
        raw = "- " + slm_generate(prompt, 360, tele, "Writing cheat sheet")
        bullets = parse_bullets(raw, 14)
        fallback = len(bullets) < 3
        if fallback:  # a 0.5B model occasionally ignores the format; fall back to the document's own key sentences
            bullets = _extractive_points(ctx, 12)
            if len(bullets) < 3:
                raise RuntimeError("The AI engine didn't return a usable summary — please try again.")
        score = grounding_score(" ".join(bullets), source_text)
        _note(tele, "Typesetting the one-page cheat sheet", 0.97)
        terms = key_terms(chunks, sentences(page_texts), 10)
        meta = f"{span} - generated on-device by S.py Edge AI - grounding check {score:.0f}%"
        pdf = build_cheatsheet_pdf(f"Cheat sheet: {short_title}", meta, bullets, terms)
        pages_out = 1
    else:
        ctx = diverse_context(ranked, chunks, 5)
        excerpts = _context_block(ctx)
        # Two small, easy prompts work far better on a 0.5B model than one structured one.
        overview, takeaways, fallback = "", [], False
        for attempt in range(2):
            raw = slm_generate("Using ONLY the excerpts below, write one paragraph of about 100 words summarising what this document is about. "
                               "Do not add facts that are not in the excerpts. Plain prose, no lists.\n\nEXCERPTS:\n"
                               f"{excerpts}\n\nSUMMARY PARAGRAPH:\n", 220, tele, "Writing the overview")
            overview = re.sub(r"\s+", " ", re.sub(r"(?i)^\s*(overview|summary paragraph|summary):?\s*", "", raw)).strip()
            if len(overview.split()) >= 25:
                break
        for attempt in range(2):
            raw = "- " + slm_generate("Using ONLY the excerpts below, list 7 key takeaways. Each line starts with '- ', is under 25 words, and ends "
                                      "with its page like [p.3]. Do not add facts that are not in the excerpts.\n\nEXCERPTS:\n"
                                      f"{excerpts}\n\nKEY TAKEAWAYS:\n- ", 300, tele, "Writing the key takeaways")
            takeaways = parse_bullets(raw, 8)
            if len(takeaways) >= 3:
                break
        if len(overview.split()) < 25:
            overview, fallback = _extractive_overview(ctx), True
        if len(takeaways) < 3:
            takeaways, fallback = _extractive_points(ctx, 7), True
        if len(takeaways) < 3:
            raise RuntimeError("The AI engine didn't return a usable summary — please try again.")
        score = grounding_score(overview + " " + " ".join(takeaways), source_text)
        _note(tele, "Typesetting the 3-page executive summary", 0.97)
        sents = sentences(page_texts)
        terms = key_terms(chunks, sents, 24)
        passages = [(c["page"], c["text"]) for c in ranked]
        formulas = [(p, s) for p, s in sents if "=" in s or re.search(r"\d+(\.\d+)?\s?(%|kg|km|cm|mm|ms|hz|mhz|ghz|v|w|a|j|n)\b", s, re.I)][:10]
        meta = f"{span} - generated on-device by S.py Edge AI - grounding check {score:.0f}%"
        pdf = build_summary_pdf(f"Executive summary: {short_title}", meta, overview, takeaways, passages, terms, formulas)
        pages_out = 3

    Path(dst).write_bytes(pdf)
    return {"pages": pages_out, "score": score,
            "note": (f"Grounding check: {score:.0f}% of the AI-written text's key terms appear in your document."
                     + (" Parts of this summary use the document's own key sentences." if fallback else ""))}