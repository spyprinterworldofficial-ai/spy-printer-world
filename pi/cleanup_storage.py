"""
Frees Supabase Storage: deletes files in the print-files bucket older than KEEP_HOURS, except files that belong
to a job that is paid / printing right now. Old uploads nobody paid for were never being deleted.

One-off (on a Pi, from ~/aprinter/pi):   set -a; . ./.env; set +a; venv/bin/python cleanup_storage.py
Dry run first (lists, deletes nothing):  ... venv/bin/python cleanup_storage.py --dry-run
The print worker also runs clean_old_files() once an hour for its own printer's folder.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

BUCKET = "print-files"
KEEP_HOURS = int(os.environ.get("STORAGE_KEEP_HOURS", "24"))
ACTIVE = ("PAID", "PRINTING")


def _walk(bucket, prefix=""):
    """All files under prefix (folders are expanded). Collected first, deleted after, so paging stays correct."""
    out, offset = [], 0
    while True:
        items = bucket.list(prefix, {"limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}})
        for it in items or []:
            path = f"{prefix}/{it['name']}" if prefix else it["name"]
            if it.get("id") is None:  # a folder
                out.extend(_walk(bucket, path))
            else:
                out.append((path, it))
        if not items or len(items) < 1000:
            return out
        offset += 1000


def _created(it) -> datetime:
    raw = it.get("created_at") or it.get("updated_at") or "1970-01-01T00:00:00Z"
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def clean_old_files(supabase, prefix="", dry_run=False, log=print) -> int:
    """Returns bytes freed."""
    active = supabase.table("print_jobs").select("storage_path, converted_pdf_path, ai_pdf_path") \
        .in_("status", list(ACTIVE)).execute().data or []
    keep = {p for j in active for p in j.values() if p}
    keep |= {p + suffix for p in list(keep) for suffix in (".clean.pdf", ".ai.pdf")}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=KEEP_HOURS)
    bucket = supabase.storage.from_(BUCKET)
    old = [(p, it) for p, it in _walk(bucket, prefix) if p not in keep and _created(it) < cutoff]
    size = sum(int((it.get("metadata") or {}).get("size") or 0) for _, it in old)
    log(f"[cleanup] {len(old)} file(s) older than {KEEP_HOURS} h, {size / 1048576:.1f} MB{' (dry run)' if dry_run else ''}")
    if not dry_run:
        paths = [p for p, _ in old]
        for i in range(0, len(paths), 100):
            bucket.remove(paths[i:i + 100])
    return size


if __name__ == "__main__":
    from supabase import create_client
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    clean_old_files(sb, "", dry_run="--dry-run" in sys.argv)