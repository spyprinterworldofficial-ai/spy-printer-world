"""
S.py Printing World — Raspberry Pi print worker.

Runs continuously. Each cycle it:
  1. Sends a heartbeat (checks internet + printer reachability, updates the
     `printers` row so the kiosk website's status indicator stays accurate).
  2. Looks for the oldest PAID job for this printer.
  3. Downloads the file from Supabase Storage.
  4. Converts to PDF first if it's a PPT/DOC (LibreOffice headless).
  5. Sends it to the Brother printer via CUPS (`lp`).
  6. Marks it COMPLETED (or FAILED on error) and decrements paper_remaining.

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

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PRINTER_ID = os.environ["PRINTER_ID"]
CUPS_PRINTER_NAME = os.environ["CUPS_PRINTER_NAME"]
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "5"))

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


def set_job_status(job_id: str, status: str, extra: dict | None = None):
    payload = {"status": status}
    if extra:
        payload.update(extra)
    supabase.table("print_jobs").update(payload).eq("id", job_id).execute()


def download_job_file(storage_path: str, dest_path: Path):
    data = supabase.storage.from_(STORAGE_BUCKET).download(storage_path)
    dest_path.write_bytes(data)


def convert_to_pdf(src_path: Path, workdir: Path) -> Path:
    """Uses headless LibreOffice to convert PPT/DOC files to PDF before
    printing. This is the accurate-page-count reconciliation point
    mentioned in the frontend README — LibreOffice's rendered PDF page
    count is the real, final page count for these file types."""
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


def print_file(pdf_or_image_path: Path, copies: int):
    subprocess.run(
        ["lp", "-d", CUPS_PRINTER_NAME, "-n", str(max(1, copies)), str(pdf_or_image_path)],
        check=True, timeout=60,
    )


def process_job(job: dict):
    job_id = job["id"]
    file_name = job["file_name"]
    storage_path = job["storage_path"]
    file_type = job["file_type"]
    pages_count = job["pages_count"]
    copies = job.get("copies", 1) or 1

    print(f"[job {job_id}] picked up: {file_name} ({file_type}, {pages_count}p x{copies})")
    set_job_status(job_id, "PRINTING")

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        local_path = workdir / file_name
        download_job_file(storage_path, local_path)

        print_target = local_path
        if file_type in CONVERTIBLE_CATEGORIES:
            print(f"[job {job_id}] converting {file_type} to PDF via LibreOffice...")
            print_target = convert_to_pdf(local_path, workdir)

        print(f"[job {job_id}] sending to printer '{CUPS_PRINTER_NAME}'...")
        print_file(print_target, copies)

    # Deduct paper. Never go negative — floor at 0 so the low-paper warning
    # on the kiosk still shows correctly rather than a nonsensical value.
    printer_row = supabase.table("printers").select("paper_remaining").eq("id", PRINTER_ID).single().execute().data
    new_remaining = max(0, printer_row["paper_remaining"] - pages_count * copies)
    supabase.table("printers").update({"paper_remaining": new_remaining}).eq("id", PRINTER_ID).execute()

    set_job_status(job_id, "COMPLETED")
    print(f"[job {job_id}] done. paper_remaining now {new_remaining}")


def main_loop():
    print(f"S.py print worker starting for printer_id={PRINTER_ID}, CUPS queue='{CUPS_PRINTER_NAME}'")
    while True:
        try:
            online, printer_ok = send_heartbeat()
            if not online:
                print("[loop] no internet — skipping job check this cycle")
            elif not printer_ok:
                print("[loop] printer not reachable via CUPS — skipping job check this cycle")
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