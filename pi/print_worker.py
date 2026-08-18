"""
S.py Printing World — Raspberry Pi print worker.

Runs continuously. Each cycle it:
  1. Sends a heartbeat (checks internet + printer reachability, updates the
     `printers` row so the kiosk website's status indicator stays accurate).
  2. Looks for a COUNTING job (a PPT/DOC someone just selected, waiting for
     its real page count) and, if found, converts it and writes back the
     exact page count + price. This only needs internet, not the physical
     printer, so it still runs even if the USB cable is unplugged.
  3. Looks for the oldest PAID job and, if the physical printer is reachable,
     downloads, converts if needed, and prints it.
  4. Marks jobs COMPLETED/FAILED/COUNT_FAILED as appropriate and updates
     paper/cartridge counters.

Run this directly for testing, or install it as a systemd service (see
spy-print-worker.service in this same folder) so it survives reboots and
restarts automatically if it crashes.
"""

import os
import subprocess
import tempfile
import time
import traceback
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client, Client
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PRINTER_ID = os.environ["PRINTER_ID"]
CUPS_PRINTER_NAME = os.environ["CUPS_PRINTER_NAME"]
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
# Must match COST_PER_PAGE in the website's page.tsx — this is what actually
# determines the charge now, server-side, not the browser.
COST_PER_PAGE = int(os.environ.get("COST_PER_PAGE", "4"))

STORAGE_BUCKET = "print-files"
CONVERTIBLE_CATEGORIES = {"PPT", "DOC"}
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def check_internet() -> bool:
    try:
        requests.get("https://www.google.com", timeout=5)
        return True
    except requests.RequestException:
        return False


def check_printer_connected() -> bool:
    try:
        result = subprocess.run(
            ["lpstat", "-p", CUPS_PRINTER_NAME],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def send_heartbeat():
    online = check_internet()
    printer_ok = check_printer_connected() if online else False
    try:
        supabase.table("printers").update({
            "pi_internet_online": online,
            "pi_printer_connected": printer_ok,
            "last_heartbeat": "now()",
        }).eq("id", PRINTER_ID).execute()
    except Exception as e:
        # If this fails, we likely have no internet anyway — just log and
        # keep the worker alive for next cycle.
        print(f"[heartbeat] failed to update: {e}")
    return online, printer_ok


def fetch_next_job():
    resp = (
        supabase.table("print_jobs")
        .select("*")
        .eq("printer_id", PRINTER_ID)
        .eq("status", "PAID")
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def fetch_next_counting_job():
    resp = (
        supabase.table("print_jobs")
        .select("*")
        .eq("printer_id", PRINTER_ID)
        .eq("status", "COUNTING")
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def set_job_status(job_id: str, status: str, extra: dict | None = None):
    payload = {"status": status}
    if extra:
        payload.update(extra)
    supabase.table("print_jobs").update(payload).eq("id", job_id).execute()


def download_job_file(storage_path: str, dest_path: Path):
    data = supabase.storage.from_(STORAGE_BUCKET).download(storage_path)
    dest_path.write_bytes(data)


def convert_to_pdf(src_path: Path, workdir: Path) -> Path:
    """Uses headless LibreOffice to convert PPT/DOC files to PDF. Used both
    for actual printing and for exact page counting (below) — the same
    conversion either way, so the count the person pays for and the pages
    that actually come out of the printer are always the same source of
    truth."""
    subprocess.run(
        [
            "libreoffice", "--headless", "--norestore",
            "--convert-to", "pdf", "--outdir", str(workdir), str(src_path),
        ],
        check=True, timeout=120,
    )
    pdf_path = workdir / (src_path.stem + ".pdf")
    if not pdf_path.exists():
        raise RuntimeError(f"LibreOffice conversion did not produce {pdf_path}")
    return pdf_path


def get_pdf_page_count(pdf_path: Path) -> int:
    """Requires poppler-utils (`sudo apt install poppler-utils`) for the
    `pdfinfo` command."""
    result = subprocess.run(
        ["pdfinfo", str(pdf_path)], capture_output=True, text=True, timeout=30, check=True
    )
    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    raise RuntimeError("Could not find a 'Pages:' line in pdfinfo output")


def extract_page_range(source_pdf: Path, page_range: str, workdir: Path) -> Path:
    """Extracts only the specified pages into a new PDF using qpdf.
    page_range is always a fully-expanded, deduped, sorted comma list
    (e.g. "1,3,5,6,7,8,9,12") written by the frontend — never shorthand
    like "5-9" — so there's no ambiguity between the page count someone
    was billed for and what actually gets extracted here. Requires
    `sudo apt install qpdf`."""
    output_path = workdir / "page_range_extract.pdf"
    subprocess.run(
        ["qpdf", str(source_pdf), "--pages", str(source_pdf), page_range, "--", str(output_path)],
        check=True, timeout=60,
    )
    if not output_path.exists():
        raise RuntimeError("qpdf did not produce the extracted page range PDF")
    return output_path


def generate_blank_pdf(num_pages: int, output_path: Path):
    """Blank-page orders never had a real file to begin with — this
    generates the PDF fresh at print time instead of downloading or
    converting anything. A4 to match everything else this printer
    produces."""
    c = canvas.Canvas(str(output_path), pagesize=A4)
    for _ in range(num_pages):
        c.showPage()
    c.save()


def print_file(pdf_or_image_path: Path, copies: int):
    subprocess.run(
        ["lp", "-d", CUPS_PRINTER_NAME, "-n", str(max(1, copies)), str(pdf_or_image_path)],
        check=True, timeout=60,
    )


def wait_until_printer_idle(timeout_seconds: int = 120):
    """`lp` returns as soon as CUPS *accepts* a job into the queue — not
    once the printer has actually finished physically printing it. With a
    single file that timing gap never matters, but back-to-back files
    (e.g. a multi-file order) can have the next job submitted to CUPS
    while the printer is still mid-way through the previous one, and some
    driver/printer combinations silently drop or mishandle a job that
    arrives while they're still busy — CUPS still reports success, so
    nothing looks wrong in our logs even though nothing came out.
    Waiting here until CUPS reports the printer idle again, before we
    consider the job truly done and move on to the next one, closes that
    gap."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            result = subprocess.run(
                ["lpstat", "-p", CUPS_PRINTER_NAME],
                capture_output=True, text=True, timeout=10,
            )
            if "is idle" in result.stdout:
                return True
        except Exception:
            pass
        time.sleep(2)
    print(f"[print] Warning: printer did not report idle within {timeout_seconds}s — proceeding anyway.")
    return False


def upload_converted_pdf(pdf_path: Path, original_storage_path: str) -> str:
    """Uploads the PDF produced during counting back to Storage, so printing
    later can reuse this exact file instead of converting again — see the
    comment on convert_to_pdf for why that determinism matters."""
    converted_path = f"{original_storage_path}.converted.pdf"
    with open(pdf_path, "rb") as f:
        supabase.storage.from_(STORAGE_BUCKET).upload(
            converted_path, f, file_options={"upsert": "true"}
        )
    return converted_path


def process_counting_job(job: dict):
    """Converts a PPT/DOC to find its exact page count, then writes the
    real pages_count + amount_paid back and flips the job to PENDING
    (ready for checkout). The converted PDF is uploaded back to Storage
    (converted_pdf_path) so that printing later reuses this exact file
    instead of re-converting — guaranteeing the pages someone paid for are
    exactly the pages that get printed, not a second, possibly slightly
    different, conversion of the same source file.

    Every write here is guarded with .eq('status', 'COUNTING') so that if
    the website deleted this job in the meantime (person removed the file
    before we finished), the update simply matches zero rows instead of
    resurrecting a row the person already discarded."""
    job_id = job["id"]
    file_name = job["file_name"]
    storage_path = job["storage_path"]
    copies = job.get("copies", 1) or 1

    print(f"[count {job_id}] counting pages for {file_name}")

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        local_path = workdir / file_name
        download_job_file(storage_path, local_path)
        pdf_path = convert_to_pdf(local_path, workdir)
        pages = get_pdf_page_count(pdf_path)
        converted_pdf_path = upload_converted_pdf(pdf_path, storage_path)

    amount = pages * copies * COST_PER_PAGE
    supabase.table("print_jobs").update({
        "pages_count": pages,
        "amount_paid": amount,
        "status": "PENDING",
        "converted_pdf_path": converted_pdf_path,
    }).eq("id", job_id).eq("status", "COUNTING").execute()
    print(f"[count {job_id}] done: {pages} pages, Rs.{amount}")


def process_job(job: dict):
    job_id = job["id"]
    file_name = job["file_name"]
    storage_path = job["storage_path"]
    file_type = job["file_type"]
    converted_pdf_path = job.get("converted_pdf_path")
    page_range = job.get("page_range")
    pages_count = job["pages_count"]
    copies = job.get("copies", 1) or 1

    print(f"[job {job_id}] picked up: {file_name} ({file_type}, {pages_count}p x{copies}"
          f"{', pages ' + page_range if page_range else ''})")
    set_job_status(job_id, "PRINTING")

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)

        if file_type == 'BLANK':
            print(f"[job {job_id}] generating {pages_count} blank page(s)")
            print_target = workdir / "blank.pdf"
            generate_blank_pdf(pages_count, print_target)
        elif file_type in CONVERTIBLE_CATEGORIES and converted_pdf_path:
            # Reuse the exact PDF that was already produced and counted
            # during the counting phase, instead of converting the source
            # file again — guarantees what gets printed matches exactly
            # what was counted and charged for.
            print(f"[job {job_id}] reusing already-converted PDF from counting phase")
            print_target = workdir / "converted.pdf"
            download_job_file(converted_pdf_path, print_target)
        else:
            local_path = workdir / file_name
            download_job_file(storage_path, local_path)
            print_target = local_path
            if file_type in CONVERTIBLE_CATEGORIES:
                # Fallback path — only hit if a job somehow has no saved
                # conversion (e.g. an older job created before this
                # feature existed). Converts fresh, same as before.
                print(f"[job {job_id}] no saved conversion found, converting {file_type} fresh...")
                print_target = convert_to_pdf(local_path, workdir)

        # Applied last, after whichever PDF we're going to print has been
        # resolved above (original, converted, or reused-converted) — this
        # is what makes sure only the paid-for pages ever reach the
        # printer, regardless of file type or conversion path.
        if page_range and file_type not in ('IMAGE', 'BLANK'):
            print(f"[job {job_id}] extracting pages {page_range} before printing")
            print_target = extract_page_range(print_target, page_range, workdir)

        print(f"[job {job_id}] sending to printer '{CUPS_PRINTER_NAME}'...")
        print_file(print_target, copies)

    print(f"[job {job_id}] waiting for printer to finish before considering this job done...")
    wait_until_printer_idle()

    # Deduct paper. Never go negative — floor at 0 so the low-paper warning
    # on the kiosk still shows correctly rather than a nonsensical value.
    # cartridge_page_count tracks usage since the last cartridge replacement
    # — this is what the admin app's duty-cycle warning (10,000 pages) reads.
    # Lifetime total (for "total pages printed") is computed on-demand by
    # the admin backend from completed print_jobs, so it isn't duplicated
    # here — only cartridge_page_count needs incrementing.
    printer_row = supabase.table("printers").select("paper_remaining, cartridge_page_count").eq("id", PRINTER_ID).single().execute().data
    new_remaining = max(0, printer_row["paper_remaining"] - pages_count * copies)
    new_cartridge_count = (printer_row.get("cartridge_page_count") or 0) + pages_count * copies
    supabase.table("printers").update({
        "paper_remaining": new_remaining,
        "cartridge_page_count": new_cartridge_count,
    }).eq("id", PRINTER_ID).execute()

    set_job_status(job_id, "COMPLETED")
    print(f"[job {job_id}] done. paper_remaining now {new_remaining}")

    # The converted PDF was only ever a working artifact for counting +
    # printing — clean it up now that the job is done, so Storage doesn't
    # accumulate a permanent duplicate of every PPT/DOC ever printed.
    if converted_pdf_path:
        try:
            supabase.storage.from_(STORAGE_BUCKET).remove([converted_pdf_path])
        except Exception as e:
            print(f"[job {job_id}] could not clean up converted PDF (non-fatal): {e}")


def try_reconnect_wifi():
    """Runs `nmcli device connect wlan0` to nudge wifi back to life.
    Requires passwordless sudo for this specific command to be configured
    for this user (already the case here, since other `sudo` commands in
    this setup guide run non-interactively). Used as a self-healing
    fallback for a known Pi quirk where wifi sometimes doesn't
    auto-connect cleanly after a fresh power cycle — a manual
    `nmcli device connect wlan0` reliably fixes it when this happens, so
    the worker does that automatically instead of needing someone to SSH
    in and run it by hand."""
    try:
        result = subprocess.run(
            ["sudo", "nmcli", "device", "connect", "wlan0"],
            capture_output=True, text=True, timeout=30,
        )
        print(f"[wifi-heal] reconnect attempt: {result.stdout.strip() or result.stderr.strip()}")
    except Exception as e:
        print(f"[wifi-heal] reconnect attempt failed: {e}")


def main_loop():
    print(f"S.py print worker starting for printer_id={PRINTER_ID}, CUPS queue='{CUPS_PRINTER_NAME}'")
    consecutive_offline_cycles = 0
    # Only nudge wifi every ~60s of continuous offline-ness (12 cycles at
    # the default 5s poll interval), not every single cycle — avoids
    # hammering nmcli uselessly while giving it real chances to recover.
    RECONNECT_EVERY_N_CYCLES = max(1, round(60 / POLL_INTERVAL_SECONDS))

    while True:
        try:
            online, printer_ok = send_heartbeat()
            if not online:
                consecutive_offline_cycles += 1
                print(f"[loop] no internet — skipping this cycle (offline for {consecutive_offline_cycles} cycles)")
                if consecutive_offline_cycles % RECONNECT_EVERY_N_CYCLES == 0:
                    try_reconnect_wifi()
            else:
                consecutive_offline_cycles = 0
                # Page counting only needs internet + LibreOffice, not the
                # physical printer — it still runs even if someone's
                # unplugged the USB cable, unlike actual printing below.
                counting_job = fetch_next_counting_job()
                if counting_job:
                    try:
                        process_counting_job(counting_job)
                    except Exception as e:
                        print(f"[count {counting_job['id']}] FAILED: {e}")
                        traceback.print_exc()
                        try:
                            supabase.table("print_jobs").update({"status": "COUNT_FAILED"}) \
                                .eq("id", counting_job["id"]).eq("status", "COUNTING").execute()
                        except Exception as inner:
                            print(f"[count {counting_job['id']}] could not mark COUNT_FAILED: {inner}")

                if not printer_ok:
                    print("[loop] printer not reachable via CUPS — skipping print job check this cycle")
                else:
                    job = fetch_next_job()
                    if job:
                        try:
                            process_job(job)
                        except Exception as e:
                            print(f"[job {job['id']}] FAILED: {e}")
                            traceback.print_exc()
                            try:
                                set_job_status(job["id"], "FAILED")
                            except Exception as inner:
                                print(f"[job {job['id']}] could not even mark as FAILED: {inner}")
        except Exception as e:
            print(f"[loop] unexpected error: {e}")
            traceback.print_exc()

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main_loop()