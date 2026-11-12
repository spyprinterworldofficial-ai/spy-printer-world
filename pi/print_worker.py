"""
S.py Printing World — Raspberry Pi print worker.

Threads
  heartbeat   every few seconds: internet/printer checks, capability flags, wifi self-heal
  AI job      one at a time: page counting, Green AI, cheat sheet / executive summary (COUNTING jobs)
  main        keeps printing PAID jobs while the AI thread works

AI features need `ai_engine.py` + its libraries. Without them this worker still prints normally
and simply reports ai_ready/slm_ready = false so the kiosk hides those options.
"""

import hashlib
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import traceback
from pathlib import Path

import requests
from urllib.parse import urlparse
from dotenv import load_dotenv
from supabase import create_client, Client
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

try:
    import ai_engine
except Exception as e:  # missing libs on a Pi that hasn't been upgraded yet
    ai_engine = None
    print(f"[startup] AI features disabled: {e}")

import inspector  # mandatory: nothing reaches the printer without passing it (fail closed)
from inspector import FileRejected

load_dotenv()

# Any blocking network call must eventually raise, otherwise a routing black hole freezes the worker silently.
socket.setdefaulttimeout(15)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PRINTER_ID = os.environ["PRINTER_ID"]
CUPS_PRINTER_NAME = os.environ["CUPS_PRINTER_NAME"]
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "5"))

STORAGE_BUCKET = "print-files"
COUNT_WORKERS = max(1, int(os.environ.get("COUNT_WORKERS", "2")))        # file checks that may run at once (Pi has 4 cores)
MIN_FREE_MB_TO_START = int(os.environ.get("MIN_FREE_MB_TO_START", "450"))  # don't start another check when RAM is this tight
COUNT_POLL_SECONDS = float(os.environ.get("COUNT_POLL_SECONDS", "1.5"))  # how soon a new upload gets picked up
COUNT_WATCHDOG_SECONDS = int(os.environ.get("COUNT_WATCHDOG_SECONDS", "420"))  # AI summaries are slow on a Pi; normal checks take seconds
MAX_COPIES_PER_JOB = int(os.environ.get("MAX_COPIES_PER_JOB", "50"))
OFFICE_SUFFIXES = {".ppt", ".pptx", ".pps", ".ppsx", ".odp", ".doc", ".docx", ".odt", ".rtf"}
CONVERTIBLE_CATEGORIES = {"PPT", "DOC"}
LIBREOFFICE_KEEPWARM_INTERVAL = 25

FALLBACK_PRICING = {"cost_per_page": 5.0, "duplex_cost_per_sheet": 4.5, "green_ai_fee": 2.0,
                    "cheatsheet_price": 4.0, "execsum_price": 8.0}


def new_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


class _PerThreadClient:
    """The Supabase client (HTTP/2) is not safe to share between threads: two uploads at once corrupt each other.
    Every thread therefore talks through its own client; check jobs borrow one from a small reusable pool."""

    def __init__(self):
        self._tl = threading.local()
        self._pool: list = []
        self._pool_lock = threading.Lock()

    def _mine(self):
        c = getattr(self._tl, "client", None)
        if c is None:
            c = self._tl.client = new_client()
        return c

    def __getattr__(self, name):
        return getattr(self._mine(), name)

    def borrow(self):
        with self._pool_lock:
            c = self._pool.pop() if self._pool else new_client()
        self._tl.client = c

    def give_back(self):
        c = getattr(self._tl, "client", None)
        self._tl.client = None
        if c is not None:
            with self._pool_lock:
                self._pool.append(c)


supabase = _PerThreadClient()

lo_lock = threading.Lock()  # headless LibreOffice can't run two instances on one profile
last_libreoffice_activity = 0.0
hb_lock = threading.Lock()
hb = {"online": False, "printer_ok": False, "write_ok": False}


# ---------------------------------------------------------------- checks / self-heal

def check_internet() -> bool:
    """Can this Pi reach what actually matters (Supabase)? Some campus networks block or slow google.com while everything we need works."""
    try:
        socket.create_connection((urlparse(SUPABASE_URL).hostname, 443), timeout=4).close()
        return True
    except OSError:
        pass
    try:
        requests.get("https://www.google.com", timeout=4)
        return True
    except requests.RequestException:
        return False


def check_printer_connected() -> bool:
    try:
        r = subprocess.run(["lpstat", "-p", CUPS_PRINTER_NAME], capture_output=True, text=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def try_reconnect_wifi():
    """`nmcli device connect wlan0` fixes the occasional post-boot wifi stall (needs passwordless sudo)."""
    try:
        r = subprocess.run(["sudo", "nmcli", "device", "connect", "wlan0"], capture_output=True, text=True, timeout=30)
        print(f"[wifi-heal] {r.stdout.strip() or r.stderr.strip()}")
    except Exception as e:
        print(f"[wifi-heal] failed: {e}")


def detect_capabilities() -> dict:
    ai_ready = ai_engine is not None
    return {"ai_ready": ai_ready, "slm_ready": ai_ready and ai_engine.slm_available()}


def heartbeat_loop():
    client = new_client()
    failures, last_caps, caps, warned = 0, 0.0, {"ai_ready": False, "slm_ready": False}, False
    reconnect_every = max(1, round(60 / POLL_INTERVAL_SECONDS))
    while True:
        try:
            online = check_internet()
            printer_ok = check_printer_connected()  # local CUPS check: independent of the internet
            if time.time() - last_caps > 30:
                caps, last_caps = detect_capabilities(), time.time()
            base = {"pi_internet_online": online, "pi_printer_connected": printer_ok, "last_heartbeat": "now()"}
            ok = False
            try:
                client.table("printers").update({**base, **caps}).eq("id", PRINTER_ID).execute()
                ok = True
            except Exception as e:
                try:  # capability columns missing (migration not run yet) — keep the heartbeat alive
                    client.table("printers").update(base).eq("id", PRINTER_ID).execute()
                    ok = True
                    if not warned:
                        print(f"[heartbeat] capability columns missing, run the AI migration ({e})")
                        warned = True
                except Exception as e2:
                    print(f"[heartbeat] failed: {e2}")
            with hb_lock:
                hb.update(online=online, printer_ok=printer_ok, write_ok=ok)
            if ok:
                failures = 0
            else:
                failures += 1
                if failures % reconnect_every == 0:
                    try_reconnect_wifi()
        except Exception as e:
            print(f"[heartbeat] unexpected error: {e}")
        time.sleep(POLL_INTERVAL_SECONDS)


# ---------------------------------------------------------------- database / storage helpers

def _first(resp):
    rows = resp.data or []
    return rows[0] if rows else None


def fetch_next_job():
    return _first(supabase.table("print_jobs").select("*").eq("printer_id", PRINTER_ID)
                  .eq("status", "PAID").order("created_at").limit(1).execute())


def fetch_counting_jobs(limit: int = 12) -> list[dict]:
    return (supabase.table("print_jobs").select("*").eq("printer_id", PRINTER_ID)
            .eq("status", "COUNTING").order("created_at").limit(limit).execute().data or [])


def mem_available_mb() -> float:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 9999.0  # unknown (not Linux): don't block


def set_job_status(job_id: str, status: str, extra: dict | None = None):
    supabase.table("print_jobs").update({"status": status, **(extra or {})}).eq("id", job_id).execute()


def _retry(fn, tries=3):
    """Wi-Fi blips happen; a dropped connection shouldn't fail a student's upload."""
    for attempt in range(tries):
        try:
            return fn()
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"[net] storage call failed ({type(e).__name__}); retrying")
            time.sleep(1 + attempt)


def download_job_file(storage_path: str, dest: Path):
    dest.write_bytes(_retry(lambda: supabase.storage.from_(STORAGE_BUCKET).download(storage_path)))


def upload_pdf(pdf_path: Path, target_path: str) -> str:
    def go():
        with open(pdf_path, "rb") as f:
            supabase.storage.from_(STORAGE_BUCKET).upload(target_path, f, file_options={"upsert": "true"})
    _retry(go)
    return target_path


def fetch_this_printer_pricing() -> dict:
    """Fresh each time, so a price change in Supabase applies to the very next job."""
    try:
        row = (supabase.table("printers")
               .select("cost_per_page, duplex_cost_per_sheet, green_ai_fee, cheatsheet_price, execsum_price")
               .eq("id", PRINTER_ID).single().execute().data)
        return {k: float(row.get(k, v)) for k, v in FALLBACK_PRICING.items()}
    except Exception as e:
        print(f"[pricing] using fallback prices: {e}")
        return dict(FALLBACK_PRICING)


def compute_amount(pages: int, copies: int, duplex: bool, ai_mode, green_applied: bool, p: dict) -> float:
    """Mirror of computeJobAmount() in lib/pricing.ts (blank pages never reach the Pi's counting step)."""
    copies = max(1, copies)
    if ai_mode == "CHEATSHEET":
        return round(copies * p["cheatsheet_price"], 2)
    if ai_mode == "EXECSUM":
        return round(copies * p["execsum_price"], 2)
    per_copy = ((pages // 2) * p["duplex_cost_per_sheet"] + (pages % 2) * p["cost_per_page"]) if duplex else pages * p["cost_per_page"]
    return round(per_copy * copies + (p["green_ai_fee"] if green_applied else 0), 2)


# ---------------------------------------------------------------- document tools

def convert_to_pdf(src: Path, workdir: Path) -> Path:
    global last_libreoffice_activity
    with lo_lock:
        last_libreoffice_activity = time.time()
        try:
            r = inspector.run_limited(
                ["libreoffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(workdir), str(src)],
                timeout=120, cpu=110, capture_output=True)
        except FileRejected:
            subprocess.run(["pkill", "-f", "soffice.bin"], capture_output=True)  # don't leave a runaway behind
            raise
    pdf = workdir / (src.stem + ".pdf")
    if r.returncode != 0 or not pdf.exists():
        subprocess.run(["pkill", "-f", "soffice.bin"], capture_output=True)
        raise FileRejected("This document couldn't be converted safely. Try saving it as a PDF and uploading that.")
    return pdf


def warm_up_libreoffice():
    """First headless call after idling costs ~20s; keep it warm so no student pays for that."""
    global last_libreoffice_activity
    if not lo_lock.acquire(blocking=False):
        return  # a real conversion is running
    try:
        start = time.time()
        subprocess.run(["libreoffice", "--headless", "--terminate_after_init"], timeout=40, capture_output=True)
        print(f"[keepwarm] LibreOffice ready in {time.time() - start:.1f}s")
    except Exception as e:
        print(f"[keepwarm] failed (non-fatal): {e}")
    finally:
        last_libreoffice_activity = time.time()
        lo_lock.release()


def get_pdf_page_count(pdf: Path) -> int:
    r = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=30, check=True)
    for line in r.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1])
    raise RuntimeError("pdfinfo gave no page count")


def extract_page_range(src: Path, page_range: str, workdir: Path) -> Path:
    out = workdir / "page_range_extract.pdf"
    subprocess.run(["qpdf", str(src), "--pages", str(src), page_range, "--", str(out)], check=True, timeout=60)
    if not out.exists():
        raise RuntimeError("qpdf produced no output")
    return out


def generate_blank_pdf(num_pages: int, out: Path):
    c = canvas.Canvas(str(out), pagesize=A4)
    for _ in range(num_pages):
        c.showPage()
    c.save()


def print_file(path: Path, copies: int, duplex: bool = False):
    cmd = ["lp", "-d", CUPS_PRINTER_NAME, "-n", str(max(1, copies))]
    if duplex:
        cmd += ["-o", "Duplex=DuplexNoTumble"]
    subprocess.run(cmd + [str(path)], check=True, timeout=60)


def wait_until_printer_idle(timeout_seconds: int = 120):
    """`lp` returns once CUPS accepts a job, not when paper is out; wait so back-to-back jobs don't collide."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            r = subprocess.run(["lpstat", "-p", CUPS_PRINTER_NAME], capture_output=True, text=True, timeout=10)
            if "is idle" in r.stdout:
                return
        except Exception:
            pass
        time.sleep(2)
    print(f"[print] printer not idle after {timeout_seconds}s — continuing")


def parse_page_list(page_range: str | None, total: int) -> list[int]:
    if not page_range:
        return list(range(1, total + 1))
    pages = sorted({int(p) for p in page_range.split(",") if p.strip().isdigit() and 1 <= int(p) <= total})
    if not pages:
        raise ValueError("The selected page range is outside this document.")
    return pages


# ---------------------------------------------------------------- untrusted-file inspection

def safe_upload_name(ftype: str, name: str) -> str:
    """Never use the student's file name on disk (path tricks, odd characters); keep only a vetted extension."""
    suffix = Path(name).suffix.lower()
    if ftype in CONVERTIBLE_CATEGORIES:
        if suffix not in OFFICE_SUFFIXES:
            raise FileRejected("This file type isn't supported. Please upload a .pptx, .ppt, .docx or .doc file.")
        return "upload" + suffix
    return "upload.bin"


def inspect_upload(ftype: str, original: Path, wd: Path) -> tuple[Path, dict]:
    """Original upload -> rebuilt clean PDF. Raises FileRejected with a student-readable reason."""
    clean = wd / "clean.pdf"
    if ftype in CONVERTIBLE_CATEGORIES:
        inspector.check_office_container(original)
        info = inspector.sanitize("pdf", convert_to_pdf(original, wd), clean)
    else:
        info = inspector.sanitize("image" if ftype == "IMAGE" else "pdf", original, clean)
    if not info["ink_ok_eco"]:
        raise FileRejected("This file is almost entirely solid black or extremely ink-heavy, so it can't be printed here.")
    info["ink_forced"] = not info["ink_ok_raw"]  # heavy but legitimate (dark slides): Eco-Ink is forced on
    return clean, info


def reject_upload(job: dict, reason: str):
    """Mark the job rejected (the kiosk shows the reason) and delete the offending bytes."""
    print(f"[reject {job['id']}] {job.get('file_name')}: {reason}")
    supabase.table("print_jobs").update({"status": "COUNT_FAILED", "ai_error": ("REJECTED: " + reason)[:200], "ai_telemetry": None}) \
        .eq("id", job["id"]).execute()
    paths = [p for p in (job.get("storage_path"), job.get("converted_pdf_path"), job.get("ai_pdf_path")) if p]
    if paths:
        try:
            supabase.storage.from_(STORAGE_BUCKET).remove(paths)
        except Exception as e:
            print(f"[reject {job['id']}] cleanup skipped: {e}")


# ---------------------------------------------------------------- AI / counting job (runs on its own thread)

def process_counting_job(job: dict):
    """COUNTING covers: exact page count of a PPT/DOC, Green AI compression, and summary generation."""
    jid, ftype, name = job["id"], job["file_type"], job["file_name"]
    ai_mode, green = job.get("ai_mode"), bool(job.get("green_ai"))
    wants_ai = bool(ai_mode or green)
    copies = job.get("copies") or 1
    duplex = bool(job.get("duplex")) or ai_mode == "EXECSUM"
    print(f"[count {jid}] {name} ({ftype}){' ' + ai_mode if ai_mode else ''}{' GREEN' if green else ''}")

    if wants_ai and ai_engine is None:
        raise RuntimeError("AI features aren't installed on this printer yet.")

    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)
        src = wd / "source.pdf"
        conv_path = job.get("converted_pdf_path")
        ink_forced = bool(job.get("ink_forced"))
        inspected, drop_original = {}, None

        if job.get("inspected_at") and conv_path:
            # Already vetted earlier (this is an AI request on a PENDING job). Re-vet anyway: storage isn't trusted.
            raw = wd / "prev.pdf"
            download_job_file(conv_path, raw)
            info = inspector.sanitize("pdf", raw, src)
            base = info["pages"]
        else:
            original = wd / safe_upload_name(ftype, name)
            download_job_file(job["storage_path"], original)
            clean, info = inspect_upload(ftype, original, wd)
            clean.replace(src)
            base, ink_forced = info["pages"], info["ink_forced"]
            conv_path = upload_pdf(src, f"{job['storage_path']}.clean.pdf")
            inspected = {"inspected_at": "now()", "ink_forced": ink_forced, "eco_ink": True if ink_forced else job.get("eco_ink")}
            drop_original = job["storage_path"]  # deleted only after the result is safely saved

        patch = {"base_pages_count": base, "ai_error": None, "ai_telemetry": None,
                 "pages_count": base, "converted_pdf_path": conv_path, "status": "PENDING", **inspected}
        green_applied = False

        if wants_ai:
            out = wd / "ai_out.pdf"
            with ai_engine.Telemetry(new_client(), jid) as tele, ai_engine.pinned_cores():
                if ai_mode:
                    result = ai_engine.make_summary(ai_mode, src, parse_page_list(job.get("page_range"), base), out,
                                                    Path(name).stem, tele)
                else:
                    result = ai_engine.green_ai_compress(src, out, tele)
            if ai_mode or result["pages"] < base:
                patch.update(pages_count=result["pages"], ai_pages_count=result["pages"],
                             ai_pdf_path=upload_pdf(out, f"{job['storage_path']}.ai.pdf"),
                             ai_score=result.get("score"), ai_note=result["note"])
                green_applied = bool(green)
            else:  # Green AI found nothing to save: print the original, no fee
                patch.update(green_ai=False, ai_pages_count=None, ai_pdf_path=None, ai_note=result["note"])

        patch["amount_paid"] = compute_amount(patch["pages_count"], copies, duplex, ai_mode, green_applied,
                                              fetch_this_printer_pricing())
        saved = supabase.table("print_jobs").update(patch).eq("id", jid).eq("status", "COUNTING").execute()
        if not saved.data:
            print(f"[count {jid}] result NOT saved: the job was no longer COUNTING (changed by the kiosk?)")
        if drop_original:  # only the rebuilt PDF is ever printed; the untrusted original can go
            try:
                supabase.storage.from_(STORAGE_BUCKET).remove([drop_original])
            except Exception:
                pass
    print(f"[count {jid}] done: {patch['pages_count']} pages, Rs.{patch['amount_paid']}")


def run_counting_job(job: dict):
    supabase.borrow()
    try:
        _run_counting_job(job)
    finally:
        supabase.give_back()


def _run_counting_job(job: dict):
    try:
        process_counting_job(job)
    except FileRejected as e:
        try:
            reject_upload(job, str(e))
        except Exception as inner:
            print(f"[count {job['id']}] could not record rejection: {inner}")
    except Exception as e:
        print(f"[count {job['id']}] FAILED: {e}")
        traceback.print_exc()
        friendly = str(e) if isinstance(e, (ValueError, RuntimeError)) else "Something went wrong while preparing this file."
        try:
            supabase.table("print_jobs").update({"status": "COUNT_FAILED", "ai_error": friendly[:200], "ai_telemetry": None}) \
                .eq("id", job["id"]).eq("status", "COUNTING").execute()
        except Exception:
            try:  # ai_error column missing
                supabase.table("print_jobs").update({"status": "COUNT_FAILED"}).eq("id", job["id"]).eq("status", "COUNTING").execute()
            except Exception as inner:
                print(f"[count {job['id']}] could not mark COUNT_FAILED: {inner}")


# ---------------------------------------------------------------- printing

def apply_eco_ink(target: Path, ftype: str, wd: Path):
    """Returns (path_to_print, ink_saved_pct or None). Never raises: eco-ink must not block a paid print."""
    if ai_engine is None:
        return target, None
    try:
        if ftype == "IMAGE":
            stats = ai_engine.eco_ink_image(target, wd / "eco.png")
            return wd / "eco.png", stats["ink_saved_pct"]
        stats = ai_engine.eco_ink_pdf(target, wd / "eco.pdf")
        return (wd / "eco.pdf", stats["ink_saved_pct"]) if stats else (target, 0.0)
    except Exception as e:
        print(f"[eco-ink] skipped: {e}")
        return target, None


def process_job(job: dict):
    jid, name, ftype = job["id"], job["file_name"], job["file_type"]
    ai_mode, green = job.get("ai_mode"), bool(job.get("green_ai"))
    page_range, converted, ai_path = job.get("page_range"), job.get("converted_pdf_path"), job.get("ai_pdf_path")
    pages, copies = job["pages_count"], job.get("copies") or 1
    duplex = bool(job.get("duplex")) or ai_mode == "EXECSUM"
    print(f"[job {jid}] {name} ({ftype}, {pages}p x{copies}{', duplex' if duplex else ''}"
          f"{', ' + ai_mode if ai_mode else ''}{', green' if green else ''}{', eco-ink' if job.get('eco_ink') else ''})")
    set_job_status(jid, "PRINTING")

    ink_saved = None
    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)
        if ftype == "BLANK":
            target = wd / "blank.pdf"
            generate_blank_pdf(pages, target)
        else:
            if not job.get("inspected_at"):
                raise FileRejected("This file was never checked and can't be printed.")
            source_path = ai_path if (ai_mode or green) else converted
            if not source_path:
                raise FileRejected("The prepared file for this job is missing.")
            target = wd / "in.pdf"
            download_job_file(source_path, target)

            if page_range and not (ai_mode or green):
                if not re.fullmatch(r"\d{1,4}(,\d{1,4}){0,999}", page_range):
                    raise FileRejected("The selected page range isn't valid.")
                target = extract_page_range(target, page_range, wd)

            if job.get("eco_ink") or job.get("ink_forced"):
                target, ink_saved = apply_eco_ink(target, "PDF", wd)

            # Last gate. Storage and the browser-editable columns aren't trusted, so what is about to hit CUPS
            # is rebuilt and re-measured: never more pages than were paid for, never an ink bomb.
            final = wd / "final.pdf"
            info = inspector.sanitize("pdf", target, final)
            if info["pages"] > pages:
                raise FileRejected("The page count doesn't match what was paid for, so this job wasn't printed.")
            if not info["ink_ok_raw"]:
                raise FileRejected("This file is too ink-heavy to print.")
            target = final

        if copies > MAX_COPIES_PER_JOB:
            raise FileRejected("Too many copies requested.")

        print(f"[job {jid}] sending to '{CUPS_PRINTER_NAME}'")
        print_file(target, copies, duplex)

    wait_until_printer_idle()

    # Paper counts sheets (a duplex copy of an odd page count still uses ceil(p/2) sheets);
    # toner counts logical pages either way.
    sheets = (-(-pages // 2)) * copies if duplex else pages * copies
    row = supabase.table("printers").select("paper_remaining, cartridge_page_count").eq("id", PRINTER_ID).single().execute().data
    remaining = max(0, row["paper_remaining"] - sheets)
    supabase.table("printers").update({
        "paper_remaining": remaining,
        "cartridge_page_count": (row.get("cartridge_page_count") or 0) + pages * copies,
    }).eq("id", PRINTER_ID).execute()

    set_job_status(jid, "COMPLETED")
    if ink_saved is not None:
        try:
            supabase.table("print_jobs").update({"ink_saved_pct": ink_saved}).eq("id", jid).execute()
        except Exception:
            pass
    print(f"[job {jid}] done. paper_remaining={remaining}{f', ink saved {ink_saved}%' if ink_saved else ''}")

    leftovers = [p for p in (converted, ai_path) if p]
    if leftovers:
        try:
            supabase.storage.from_(STORAGE_BUCKET).remove(leftovers)
        except Exception as e:
            print(f"[job {jid}] cleanup skipped: {e}")


# ---------------------------------------------------------------- main loop

def counting_dispatch_loop():
    """Own thread: checks students' files side by side, independent of whatever the printing loop is doing."""
    running: dict[str, tuple[threading.Thread, float, bool]] = {}  # job id -> (thread, started, uses_ai)
    runs: dict[str, list[float]] = {}  # job id -> when we started it (to catch a job that keeps coming back)
    last_warn, last_busy_log = 0.0, 0.0
    while True:
        try:
            with hb_lock:
                write_ok = hb["write_ok"]
            if not write_ok:
                if time.time() - last_warn > 30:
                    print("[count-loop] can't reach Supabase — waiting (heartbeat thread is retrying)")
                    last_warn = time.time()
            else:
                for jid in [j for j, (t, _, _) in running.items() if not t.is_alive()]:
                    del running[jid]

                # Only one AI (Ollama) job at a time, since it needs the CPU cores; everything else runs in parallel.
                if len(running) < COUNT_WORKERS:
                    ai_running = any(uses_ai for _, _, uses_ai in running.values())
                    plain_running = sum(1 for _, _, uses_ai in running.values() if not uses_ai)
                    now = time.time()
                    for job in fetch_counting_jobs():
                        if len(running) >= COUNT_WORKERS:
                            break
                        jid = job["id"]
                        uses_ai = bool(job.get("ai_mode") or job.get("green_ai"))
                        if jid in running or (uses_ai and ai_running):
                            continue
                        recent = [t for t in runs.get(jid, []) if now - t < 1200]
                        if len(recent) >= 3:  # finished 3 times in 20 min and it's back again: never loop forever
                            print(f"[count {jid}] keeps coming back to COUNTING — failing it so the queue keeps moving")
                            supabase.table("print_jobs").update({"status": "COUNT_FAILED", "ai_telemetry": None,
                                "ai_error": "This file couldn't finish preparing. Please remove it and upload it again."}) \
                                .eq("id", jid).eq("status", "COUNTING").execute()
                            runs.pop(jid, None)
                            continue
                        if running:
                            mem = mem_available_mb()
                            # An AI job holds most of the RAM; a plain file check is light. Always allow ONE plain check
                            # next to it (unless RAM is critically low), so AI requests can never block other students.
                            plain_ok = not uses_ai and plain_running == 0 and mem >= 200
                            if mem < MIN_FREE_MB_TO_START and not plain_ok:
                                continue
                        t = threading.Thread(target=run_counting_job, args=(job,), daemon=True)
                        running[jid] = (t, now, uses_ai)
                        runs[jid] = recent + [now]
                        ai_running = ai_running or uses_ai
                        plain_running += 0 if uses_ai else 1
                        t.start()
                    for old_id in [k for k, v in runs.items() if now - max(v) > 1200]:
                        del runs[old_id]

                now = time.time()
                for jid, (t, started, _) in list(running.items()):
                    busy_for = now - started
                    if busy_for > 60 and now - last_busy_log > 60:
                        print(f"[count-loop] job {jid} has been running {busy_for:.0f}s")
                        last_busy_log = now
                    if busy_for > COUNT_WATCHDOG_SECONDS:  # a stuck job must never silently block the kiosk
                        print(f"[watchdog] job {jid} exceeded {COUNT_WATCHDOG_SECONDS}s — failing it and restarting the worker")
                        try:
                            supabase.table("print_jobs").update({"status": "COUNT_FAILED", "ai_telemetry": None,
                                "ai_error": "This file took too long to prepare. Please try again."}) \
                                .eq("id", jid).eq("status", "COUNTING").execute()
                        finally:
                            subprocess.run(["pkill", "-f", "soffice.bin"], capture_output=True)
                            os._exit(3)  # systemd (Restart=always) brings the worker back clean
        except Exception as e:
            print(f"[count-loop] unexpected error: {e}")
            traceback.print_exc()
        time.sleep(COUNT_POLL_SECONDS)


def storage_cleanup_loop():
    """Hourly: delete this printer's files older than 24 h (unpaid / abandoned uploads were never removed)."""
    import cleanup_storage
    time.sleep(60)
    while True:
        try:
            cleanup_storage.clean_old_files(supabase, PRINTER_ID)
        except Exception as e:
            print(f"[cleanup] skipped: {e}")
        time.sleep(3600)


def main_loop():
    print(f"S.py print worker starting for printer_id={PRINTER_ID}, CUPS queue='{CUPS_PRINTER_NAME}', AI={'on' if ai_engine else 'off'}, "
          f"parallel checks={COUNT_WORKERS}")
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    warm_up_libreoffice()
    inspector.warm()  # pre-load the checking libraries once, so each upload starts instantly
    threading.Thread(target=counting_dispatch_loop, daemon=True).start()
    threading.Thread(target=storage_cleanup_loop, daemon=True).start()
    last_warn = 0.0

    while True:
        try:
            if time.time() - last_libreoffice_activity > LIBREOFFICE_KEEPWARM_INTERVAL:
                warm_up_libreoffice()

            with hb_lock:
                write_ok, printer_ok = hb["write_ok"], hb["printer_ok"]

            if not write_ok:
                if time.time() - last_warn > 30:
                    print("[loop] can't reach Supabase — waiting (heartbeat thread is retrying)")
                    last_warn = time.time()
            elif printer_ok:
                job = fetch_next_job()
                if job:
                    try:
                        process_job(job)
                    except Exception as e:
                        print(f"[job {job['id']}] FAILED: {e}")
                        traceback.print_exc()
                        try:
                            extra = {"ai_error": ("REJECTED: " + str(e))[:200]} if isinstance(e, FileRejected) else None
                            set_job_status(job["id"], "FAILED", extra)
                        except Exception as inner:
                            print(f"[job {job['id']}] could not mark FAILED: {inner}")
        except Exception as e:
            print(f"[loop] unexpected error: {e}")
            traceback.print_exc()
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main_loop()