"""
S.py upload inspector: every uploaded file is untrusted.

  1. identify what it REALLY is (magic bytes, not the file name)
  2. enforce hard limits: pages, page size, image pixels, archive size
  3. REBUILD it as a clean PDF that we generate, so the page count that is verified, billed and printed
     is a property of that one file, and CUPS/Ghostscript never see the attacker's bytes
  4. measure how much toner it would use (raw, and as AI Eco-Ink would print it)

The parsing runs in a child process with CPU / memory / file-size limits and a wall-clock timeout, so a
hostile file can crash or hang only that child. Anything unexpected becomes a FileRejected.
"""

import io
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:
    import fitz

import numpy as np


def _int(name, default):
    return int(os.environ.get(name, default))


def _float(name, default):
    return float(os.environ.get(name, default))


MAX_PAGES = _int("MAX_JOB_PAGES", 300)
MAX_PAGE_DIM_PT = _int("MAX_PAGE_DIM_PT", 3400)          # A0 is 2384 x 3370 pt
MAX_IMAGE_PIXELS = _int("MAX_IMAGE_PIXELS", 60_000_000)
MAX_IMAGE_SIDE = _int("MAX_IMAGE_SIDE", 20_000)
ZIP_MAX_UNCOMPRESSED = _int("ZIP_MAX_UNCOMPRESSED_MB", 400) * 1024 * 1024
ZIP_MAX_RATIO = _int("ZIP_MAX_RATIO", 150)
ZIP_MAX_ENTRIES = _int("ZIP_MAX_ENTRIES", 8000)

# Toner policy. coverage = fraction of the page that is ink (0 white .. 1 solid black).
INK_SOLID = _float("INK_SOLID_PAGE", 0.80)               # a page this dark counts as "solid black"
FLAT_STD = _float("FLAT_STD", 6.0)                       # grey-level std-dev below which a page is "featureless"
MAX_SOLID_PAGES = _int("MAX_SOLID_PAGES", 2)             # allow a dark cover page or two
MAX_INK_UNITS = _float("MAX_INK_UNITS", 30.0)            # sum of coverage over the job (30 = thirty fully black pages)

CHILD_MEMORY = _int("INSPECT_MEMORY_MB", 1600) * 1024 * 1024
CHILD_CPU_SECONDS = _int("INSPECT_CPU_SECONDS", 60)
CHILD_FILE_BYTES = _int("INSPECT_MAX_OUTPUT_MB", 300) * 1024 * 1024
WALL_TIMEOUT = _int("INSPECT_WALL_SECONDS", 90)

A4 = (595.28, 841.89)
PAGE_MARGIN = 10.0
ALLOWED_IMAGES = {"JPEG", "PNG", "WEBP", "BMP", "GIF"}


class FileRejected(ValueError):
    """The message is shown to the student, so keep it plain and actionable."""


# ---------------------------------------------------------------- parent side

def _limited(cmd, cpu=CHILD_CPU_SECONDS, fsize=CHILD_FILE_BYTES):
    """Prefix a command with prlimit (util-linux) so even third-party tools run with hard limits."""
    if shutil.which("prlimit"):
        return ["prlimit", f"--cpu={cpu}", f"--fsize={fsize}", "--nofile=512", "--core=0", "--", *cmd]
    return list(cmd)


def run_limited(cmd, timeout, cpu=CHILD_CPU_SECONDS, fsize=CHILD_FILE_BYTES, **kw):
    try:
        return subprocess.run(_limited(cmd, cpu, fsize), timeout=timeout, **kw)
    except subprocess.TimeoutExpired as e:
        raise FileRejected("This file took too long to process and was rejected for safety.") from e


def check_office_container(path: Path):
    """Cheap pre-check before LibreOffice sees a PPT/DOC: real container type, no zip bomb."""
    with open(path, "rb") as f:
        head = f.read(8)
    if head.startswith(b"PK\x03\x04"):
        try:
            infos = zipfile.ZipFile(path).infolist()
        except zipfile.BadZipFile as e:
            raise FileRejected("This file looks corrupted. Please re-save it and upload again.") from e
        if len(infos) > ZIP_MAX_ENTRIES:
            raise FileRejected("This file contains an unusual number of parts and was rejected for safety.")
        if sum(i.file_size for i in infos) > ZIP_MAX_UNCOMPRESSED:
            raise FileRejected("This file expands to an unreasonable size and was rejected for safety.")
        for i in infos:
            if i.file_size > 20 * 1024 * 1024 and i.compress_size and i.file_size / i.compress_size > ZIP_MAX_RATIO:
                raise FileRejected("This file is abnormally compressed and was rejected for safety.")
    elif not head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):  # legacy OLE (.doc/.ppt)
        raise FileRejected("This doesn't look like a real Word or PowerPoint file.")


def sanitize(kind: str, src: Path, dst: Path) -> dict:
    """kind is 'pdf' or 'image'. Returns page count + ink metrics; dst is the rebuilt PDF."""
    env = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
    try:
        r = subprocess.run([sys.executable, str(Path(__file__).resolve()), kind, str(src), str(dst)],
                           capture_output=True, text=True, timeout=WALL_TIMEOUT, env=env)
    except subprocess.TimeoutExpired as e:
        raise FileRejected("This file took too long to check and was rejected for safety.") from e

    data = None
    for line in reversed(r.stdout.strip().splitlines()):
        try:
            data = json.loads(line)
            break
        except ValueError:
            continue
    if data and data.get("ok"):
        return data
    if data and data.get("reason"):
        raise FileRejected(data["reason"])
    # No verdict: the child was killed by a limit or crashed. Either way, don't trust the file.
    raise FileRejected("This file couldn't be processed safely and was rejected.")


# ---------------------------------------------------------------- child side

def _apply_limits():
    for res, soft, hard in (
        (resource.RLIMIT_AS, CHILD_MEMORY, CHILD_MEMORY),
        (resource.RLIMIT_CPU, CHILD_CPU_SECONDS, CHILD_CPU_SECONDS + 5),
        (resource.RLIMIT_FSIZE, CHILD_FILE_BYTES, CHILD_FILE_BYTES),
        (resource.RLIMIT_NOFILE, 256, 256),
        (resource.RLIMIT_CORE, 0, 0),
    ):
        try:
            resource.setrlimit(res, (soft, hard))
        except (ValueError, OSError):
            pass
    try:
        os.nice(5)  # never starve the heartbeat or an active print
    except OSError:
        pass


_TRANSFER = re.compile(r"/(?:TR2?|HT)\s+(?:\d+\s+\d+\s+R|/[A-Za-z0-9_.]+|<<(?:[^<>]|<<[^<>]*>>)*>>)")


def _walk_page_tree(doc) -> int:
    """Count leaf pages the way a renderer that follows /Kids would, with multiplicity. Raises FileRejected on cycles.
    Readers that trust /Count (browser page counters, pdfinfo, MuPDF) can disagree with this: that's the
    'shows 1 page, prints 100' trick (the same page object listed over and over, or a self-referencing tree)."""
    def ref(v):
        m = re.match(r"\s*(\d+)\s+0\s+R", v or "")
        return int(m.group(1)) if m else None

    root = ref(doc.xref_get_key(doc.pdf_catalog(), "Pages")[1])
    if root is None:
        raise FileRejected("This PDF's page structure is damaged. Try printing it to a new PDF and upload that.")
    leaves, visits, stack = 0, 0, [(root, frozenset())]
    while stack:
        x, path = stack.pop()
        visits += 1
        if x in path:
            raise FileRejected("This PDF has a looping page structure and was rejected for safety.")
        if visits > 20000 or leaves > MAX_PAGES + 50:
            raise FileRejected("This PDF's page structure is abnormal and was rejected for safety.")
        kind, kids = doc.xref_get_key(x, "Kids")
        if kind == "array":
            for k in re.findall(r"(\d+)\s+0\s+R", kids):
                stack.append((int(k), path | {x}))
        else:
            leaves += 1
    return leaves


def _sanitize_pdf(src, dst) -> dict:
    with open(src, "rb") as f:
        if b"%PDF-" not in f.read(1024):
            # MuPDF would happily open EPUB/XPS/SVG/CBZ... Only real PDFs are accepted here.
            raise FileRejected("This isn't a real PDF file.")
    try:
        doc = fitz.open(src, filetype="pdf")
    except Exception as e:
        raise FileRejected("This PDF is damaged or not a real PDF.") from e
    if doc.needs_pass or doc.is_encrypted:
        raise FileRejected("Password-protected PDFs can't be printed. Remove the password and upload again.")
    n = doc.page_count
    if n < 1:
        raise FileRejected("This PDF has no pages.")
    if n > MAX_PAGES:
        raise FileRejected(f"This document has {n} pages. The limit is {MAX_PAGES} pages per file.")

    walked = _walk_page_tree(doc)
    if walked != n:
        raise FileRejected(f"This PDF reports {n} page{'s' if n != 1 else ''} but actually contains {walked}. It was rejected because the page count can't be trusted.")

    out = fitz.open()
    for i in range(n):
        try:
            src_page = doc[i]
            rot = src_page.rotation
            src_page.set_rotation(0)  # in memory only: copy the unrotated page, then restore /Rotate below
            w, h = src_page.rect.width, src_page.rect.height
            if not (5 <= w <= MAX_PAGE_DIM_PT and 5 <= h <= MAX_PAGE_DIM_PT):
                raise FileRejected(f"Page {i + 1} has an unusual size ({w:.0f} x {h:.0f} pt) and was rejected for safety.")
            # Each page keeps its own size: no padding, so Eco-Ink can never turn padding into a black frame.
            page = out.new_page(width=w, height=h)
            page.show_pdf_page(page.rect, doc, i)  # keeps vector content; drops scripts, forms, attachments
            page.set_rotation(rot)
        except FileRejected:
            raise
        except Exception as e:
            raise FileRejected(f"Page {i + 1} couldn't be read. Try re-saving or printing the file to PDF, then upload again.") from e
    # Transfer functions / halftones can invert every tone in some renderers (Ghostscript honours them, MuPDF ignores them),
    # so what we measured might not be what prints. Strip them everywhere.
    for x in range(1, out.xref_length()):
        try:
            obj = out.xref_object(x, compressed=False)
        except Exception:
            continue
        if _TRANSFER.search(obj):
            out.update_object(x, _TRANSFER.sub(" ", obj))  # (a stream's data is kept by update_object)
    out.set_metadata({})
    out.save(dst, garbage=4, deflate=True)
    return {"pages": n, "note": f"{n} page{'s' if n != 1 else ''}"}


def _image_page_size(pt_w, pt_h):
    """Natural size, shrunk (never enlarged) to fit an A4 sheet in whichever orientation suits it."""
    bw, bh = (A4[1], A4[0]) if pt_w > pt_h * 1.05 else A4
    s = min(1.0, (bw - 2 * PAGE_MARGIN) / pt_w, (bh - 2 * PAGE_MARGIN) / pt_h)
    return pt_w * s, pt_h * s


def _sanitize_image(src, dst) -> dict:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        im = Image.open(src)
    except Image.DecompressionBombError as e:
        raise FileRejected("This image is far too large (its pixel dimensions are enormous). Please use a normal-sized image.") from e
    except Exception as e:
        raise FileRejected("This isn't a valid image file.") from e
    if im.format not in ALLOWED_IMAGES:
        raise FileRejected("Unsupported image type. Please upload a JPG or PNG.")
    w, h = im.size  # header only, nothing decoded yet
    if w * h > MAX_IMAGE_PIXELS or max(w, h) > MAX_IMAGE_SIDE:
        raise FileRejected(f"This image is too large ({w} x {h} pixels). Please use a smaller image.")

    dpi = im.info.get("dpi", (0, 0))[0] or 0
    dpi = float(dpi) if 50 <= float(dpi) <= 1200 else 96.0
    try:
        im.seek(0)  # animated GIF/WebP: first frame only
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            rgba = im.convert("RGBA")
            flat = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            flat.alpha_composite(rgba)
            im = flat.convert("L")
        else:
            im = im.convert("L")  # the printer is monochrome
    except Exception as e:
        raise FileRejected("This image couldn't be read.") from e

    if max(im.size) > 3600:  # more than A4 at ~300 dpi is wasted
        k = 3600 / max(im.size)
        im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
        dpi = dpi * k

    pw, ph = _image_page_size(im.width / dpi * 72, im.height / dpi * 72)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    out = fitz.open()
    page = out.new_page(width=pw, height=ph)
    page.insert_image(page.rect, stream=buf.getvalue())
    out.set_metadata({})
    out.save(dst, garbage=4, deflate=True)
    return {"pages": 1, "note": "1 page"}


def _coverage(gray) -> float:
    return float((255 - gray).mean()) / 255.0


def measure_ink(pdf_path) -> dict:
    """Toner estimate per job, raw and as AI Eco-Ink would print it (when the AI libraries are installed)."""
    try:
        import ink  # light module: not the whole AI toolkit (keeps the child process fast to start)
    except Exception:
        ink = None
    doc = fitz.open(pdf_path)
    raw, eco, flat = [], [], 0
    for page in doc:
        pix = page.get_pixmap(dpi=36, colorspace=fitz.csGRAY, alpha=False)
        g = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
        c = _coverage(g)
        raw.append(c)
        flat += c >= INK_SOLID and float(g.std()) < FLAT_STD  # solid fill with no content: no legitimate use
        eco.append(_coverage(ink.eco_ink_gray(g)) if ink and ink.page_needs_eco(g) else c)

    def verdict(cov):
        solid = sum(c >= INK_SOLID for c in cov)
        units = float(sum(cov))
        return solid, units, solid <= MAX_SOLID_PAGES and units <= MAX_INK_UNITS

    s_raw, u_raw, ok_raw = verdict(raw)
    s_eco, u_eco, ok_eco = verdict(eco)
    if flat > MAX_SOLID_PAGES:  # eco-ink can't rescue a pile of featureless black pages
        ok_raw = ok_eco = False
    return {
        "flat_solid_pages": flat, "solid_pages_raw": s_raw, "ink_units_raw": round(u_raw, 2), "ink_ok_raw": ok_raw,
        "solid_pages_eco": s_eco, "ink_units_eco": round(u_eco, 2), "ink_ok_eco": ok_eco,
    }


def _child_main(argv):
    kind, src, dst = argv
    _apply_limits()
    try:
        info = _sanitize_pdf(src, dst) if kind == "pdf" else _sanitize_image(src, dst)
        info.update(measure_ink(dst))
        print(json.dumps({"ok": True, **info}))
    except FileRejected as e:
        print(json.dumps({"ok": False, "reason": str(e)}))
        sys.exit(3)
    except MemoryError:
        print(json.dumps({"ok": False, "reason": "This file is too large or complex to process safely."}))
        sys.exit(4)
    except Exception:
        print(json.dumps({"ok": False, "reason": "This file couldn't be processed safely and was rejected."}))
        sys.exit(5)


if __name__ == "__main__":
    _child_main(sys.argv[1:])