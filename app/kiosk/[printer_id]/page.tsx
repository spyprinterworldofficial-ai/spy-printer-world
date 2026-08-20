'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

declare global {
  interface Window {
    Razorpay: any;
  }
}

const MAX_TOTAL_SIZE_BYTES = 350 * 1024 * 1024; // 350 MB across the whole order
// Per-file caps, separate from the total-batch limit above. Images
// specifically get a much smaller cap than documents — unlike a PDF
// (already print-ready data) or PPT/DOC (converted once, deterministically,
// on the Pi), a huge image has to be rasterized directly by the printer
// driver, which is a real resource-exhaustion risk on a Pi 4 and can
// produce corrupted/garbled print output if something goes wrong partway
// through processing an unusually large file.
const MAX_COPIES = 20; // per file — keeps a single order from monopolizing the physical queue for hours
const MAX_FILE_SIZE_BYTES: Record<Category, number> = {
  IMAGE: 25 * 1024 * 1024, // 25 MB — generous for any real photo, far below anything that would strain the Pi
  PDF: 100 * 1024 * 1024,
  PPT: 100 * 1024 * 1024,
  DOC: 100 * 1024 * 1024,
  BLANK: Infinity, // no file involved at all
};
// Reads from NEXT_PUBLIC_COST_PER_PAGE (set in Vercel), falling back to 4
// only if that env var is somehow missing. Must be kept in sync with
// COST_PER_PAGE in create-razorpay-order/route.ts (server-side) and the Pi
// worker's .env — three separate places since each runs in a different
// environment. This value only drives what's *displayed* and what the
// initial insert for PDF/Image jobs uses; the actual charge is always
// recomputed server-side from the database at payment time, so even if
// this one drifted, someone couldn't pay less than the real total — but
// keeping them in sync avoids showing the wrong price on screen.
const COST_PER_PAGE = Number(process.env.NEXT_PUBLIC_COST_PER_PAGE) || 4;
const BLANK_COST_PER_PAGE = Number(process.env.NEXT_PUBLIC_BLANK_COST_PER_PAGE) || 1.5;
const LOW_PAPER_THRESHOLD = 10;
// The Pi worker heartbeats every POLL_INTERVAL_SECONDS (5s by default). If
// we haven't heard from it in this long, treat it as offline even if the
// last values it wrote to the database were "online" — a Pi that's been
// switched off doesn't get to update its own row to say so.
const HEARTBEAT_STALE_MS = 20000;

type Category = 'PDF' | 'IMAGE' | 'PPT' | 'DOC' | 'BLANK';

interface PrinterStatus {
  id: string;
  name: string;
  is_enabled: boolean;
  paper_remaining: number;
  pi_internet_online: boolean;
  pi_printer_connected: boolean;
  last_heartbeat: string;
}

interface UploadedFile {
  id: string;
  file: File | null; // null for blank-page entries, which have no underlying file at all
  category: Category;
  pageCount: number; // BILLED count — equals totalPages unless a page range is selected
  totalPages: number; // the real full-document page count, used to validate ranges against
  copies: number; // how many times to print this same file — multiplies price and physical output
  estimated: boolean; // true when the count is an editable fallback, not exact
  pdfError?: string;
  pageRange?: string; // fully-expanded, deduped, sorted comma list e.g. "1,3,5,6" — undefined means "print everything"
  pageRangeError?: string;
  // Set once a PPT/DOC file has been uploaded and its print_jobs row
  // created — used to route realtime updates to the right file, and to
  // clean up storage/DB if the person removes the file before paying.
  jobId?: string;
  storagePath?: string;
  counting?: boolean; // true while the Pi is still converting/counting
  countingStartedAt?: number;
  countFailed?: boolean;
}

// Parses a page-range string like "1-5, 8, 12-15" against a known total
// page count. Returns a sorted, deduped array of individual page numbers
// (never range shorthand) — this expanded form is what gets stored and
// sent to the Pi, so there's zero ambiguity between what's billed and
// what gets physically extracted and printed later.
function parsePageRange(input: string, totalPages: number): { pages: number[]; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { pages: [] }; // empty = print everything, handled by caller

  const selected = new Set<number>();
  const tokens = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return { pages: [] };

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = token.match(/^(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end > totalPages || start > end) {
        return { pages: [], error: `"${token}" is not a valid range for this ${totalPages}-page document.` };
      }
      for (let p = start; p <= end; p++) selected.add(p);
    } else if (singleMatch) {
      const page = parseInt(singleMatch[1], 10);
      if (page < 1 || page > totalPages) {
        return { pages: [], error: `Page ${page} doesn't exist — this document has ${totalPages} pages.` };
      }
      selected.add(page);
    } else {
      return { pages: [], error: `"${token}" isn't a valid page or range (try something like "1-5, 8, 12-15").` };
    }
  }

  return { pages: Array.from(selected).sort((a, b) => a - b) };
}

interface QueueItem {
  id: string;
  file_name: string;
  pages_count: number;
  created_at: string;
}

const CATEGORY_META: Record<Category, { label: string; icon: string; gradient: string; accept: string }> = {
  PDF: { label: 'PDF', icon: 'bi-file-earmark-pdf-fill', gradient: 'linear-gradient(135deg,#ff5f6d,#c31432)', accept: '.pdf' },
  IMAGE: { label: 'Image', icon: 'bi-file-earmark-image-fill', gradient: 'linear-gradient(135deg,#36d1dc,#5b86e5)', accept: 'image/*' },
  PPT: { label: 'PPT', icon: 'bi-file-earmark-slides-fill', gradient: 'linear-gradient(135deg,#f7971e,#ffd200)', accept: '.ppt,.pptx' },
  DOC: { label: 'Doc', icon: 'bi-file-earmark-word-fill', gradient: 'linear-gradient(135deg,#00c6ff,#0072ff)', accept: '.doc,.docx' },
  BLANK: { label: 'Blank Pages', icon: 'bi-file-earmark', gradient: 'linear-gradient(135deg,#8e9eab,#4b6076)', accept: '' },
};

// ---- Page counting -------------------------------------------------------
// PDFs & images: counted exactly, instantly, in the browser — no round
// trip needed. PDFs use pdf.js with a self-hosted worker file
// (public/pdf.worker.min.mjs) rather than an external CDN, since loading
// the worker from cdnjs previously failed silently on networks that block
// or throttle that domain (common on campus/hostel wifi), causing PDFs to
// be undercounted as "1 page".
//
// PPT/DOC: a browser genuinely can't render these to get a real page
// count, so these are uploaded immediately (before payment) and the
// Raspberry Pi — which already has LibreOffice installed for printing —
// converts them and writes back the exact page count. See handleFileChange
// and the realtime subscription below for how this plays out; this section
// only covers the instant PDF/image path.

async function getPdfPageCount(file: File): Promise<number> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  return pdf.numPages;
}

// Only used as a last-resort editable fallback for PDFs whose page count
// genuinely failed to parse (corrupt file, etc) — not used for PPT/DOC at
// all anymore, since those get an exact Pi-verified count instead of a
// file-size guess.
async function resolvePdfPageCount(file: File): Promise<{ pageCount: number; estimated: boolean; pdfError?: string }> {
  try {
    const pageCount = await getPdfPageCount(file);
    return { pageCount, estimated: false };
  } catch (err) {
    console.error('PDF page count failed:', err);
    return { pageCount: 1, estimated: true, pdfError: 'Could not read page count from this PDF — please re-check it before paying.' };
  }
}

// Small self-contained control for the Blank Pages flow — a quantity
// stepper with a live price preview, separate from the file-upload UI
// since there's no file involved at all here.
function BlankPagesPicker({ onAdd, unitPrice }: { onAdd: (qty: number) => void; unitPrice: number }) {
  const [qty, setQty] = useState(1);
  return (
    <div className="d-flex flex-column gap-3 align-items-center py-3">
      <p className="text-secondary small mb-0">How many blank sheets do you need?</p>
      <div className="d-flex align-items-center gap-3">
        <button
          onClick={() => setQty((q) => Math.max(1, q - 1))}
          className="btn btn-outline-secondary rounded-circle"
          style={{ width: '44px', height: '44px' }}
        >
          <i className="bi bi-dash-lg"></i>
        </button>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.round(Number(e.target.value)) || 1))}
          className="form-control form-control-lg text-center bg-dark text-light border-secondary"
          style={{ width: '90px' }}
        />
        <button
          onClick={() => setQty((q) => q + 1)}
          className="btn btn-outline-secondary rounded-circle"
          style={{ width: '44px', height: '44px' }}
        >
          <i className="bi bi-plus-lg"></i>
        </button>
      </div>
      <p className="small text-secondary mb-0">
        ₹{unitPrice.toFixed(2)} / sheet — total ₹{(qty * unitPrice).toFixed(2)}
      </p>
      <button onClick={() => onAdd(qty)} className="btn btn-print fw-bold px-4 py-2">
        <i className="bi bi-plus-lg me-2"></i> Add to order
      </button>
    </div>
  );
}

// ---- Component ------------------------------------------------------------

export default function KioskPage() {
  const params = useParams();
  const printerId = params?.printer_id as string;

  const [showSplash, setShowSplash] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);

  // Printer status loading is tracked explicitly so we never confuse
  // "still loading" or "failed to load" with "printer is offline" — that
  // mix-up was previously leaving every button permanently disabled.
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [step, setStep] = useState<'upload' | 'checkout' | 'success'>('upload');

  const [activeQueue, setActiveQueue] = useState<QueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Forces a re-render every few seconds purely so the heartbeat-staleness
  // check below gets re-evaluated even when no new data has arrived from
  // Supabase (e.g. the Pi went silent and nothing is pushing updates).
  const [, forceTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Splash hides when the video actually finishes (onEnded below). This
  // safety-net timeout only exists in case autoplay gets silently blocked
  // by the browser and 'ended' never fires — it's deliberately much longer
  // than the video itself so it never cuts a normal playthrough short.
  useEffect(() => {
    const safetyNet = setTimeout(() => setShowSplash(false), 20000);
    return () => clearTimeout(safetyNet);
  }, []);

  useEffect(() => {
    if (document.getElementById('razorpay-checkout-js')) return;
    const script = document.createElement('script');
    script.id = 'razorpay-checkout-js';
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    const tick = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(tick);
  }, []);

  const fetchQueue = useCallback(async () => {
    if (!printerId) return;
    const { data, error } = await supabase
      .from('print_jobs')
      .select('id, file_name, pages_count, created_at')
      .eq('printer_id', printerId)
      .in('status', ['PAID', 'PRINTING'])
      .order('created_at', { ascending: true });
    if (!error && data) setActiveQueue(data as QueueItem[]);
  }, [printerId]);

  useEffect(() => {
    if (!printerId) return;

    const fetchStatus = async () => {
      setStatusLoading(true);
      setStatusError(null);
      const { data, error } = await supabase
        .from('printers')
        .select('*')
        .eq('id', printerId)
        .single();

      if (error) {
        // Full detail stays in the console for debugging; end users just
        // see a plain, non-technical message.
        console.error('Failed to load printer status (check NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel):', error);
        setStatusError('Printer is not connected. Please wait.');
      } else if (data) {
        setPrinterStatus(data as PrinterStatus);
      }
      setStatusLoading(false);
    };

    fetchStatus();
    fetchQueue();

    const channel = supabase
      .channel(`kiosk-${printerId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'printers', filter: `id=eq.${printerId}` },
        (payload) => setPrinterStatus(payload.new as PrinterStatus)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'print_jobs', filter: `printer_id=eq.${printerId}` },
        (payload) => {
          fetchQueue();
          // Route counting-job updates from the Pi back to the matching
          // file in the upload list. Using the functional setState form
          // avoids needing `files` as an effect dependency (which would
          // otherwise mean re-subscribing the whole realtime channel every
          // time the file list changes).
          const updated = payload.new as { id: string; status: string; pages_count: number; amount_paid: number };
          setFiles((prev) =>
            prev.map((f) => {
              if (f.jobId !== updated.id) return f;
              if (updated.status === 'PENDING') {
                return { ...f, pageCount: updated.pages_count, totalPages: updated.pages_count, estimated: false, counting: false, countFailed: false };
              }
              if (updated.status === 'COUNT_FAILED') {
                return { ...f, pageCount: f.pageCount || 1, totalPages: f.totalPages || 1, counting: false, countFailed: true, estimated: true };
              }
              return f; // still COUNTING or some other transient state
            })
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [printerId, fetchQueue]);

  const openPicker = (cat: Category) => {
    setSelectedCategory(cat);
    if (cat === 'BLANK') return; // no file picker — quantity UI shown instead, see the card body
    setTimeout(() => fileInputRef.current?.click(), 0);
  };

  const addBlankPages = (quantity: number) => {
    const qty = Math.max(1, Math.round(quantity) || 1);
    setFiles((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        file: null,
        category: 'BLANK',
        pageCount: qty,
        totalPages: qty,
        copies: 1,
        estimated: false,
      },
    ]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !selectedCategory) return;
    setErrorMsg(null);

    const newFiles = Array.from(e.target.files);
    const currentTotalSize = files.reduce((acc, f) => acc + (f.file?.size || 0), 0);
    const newFilesTotalSize = newFiles.reduce((acc, f) => acc + f.size, 0);

    if (currentTotalSize + newFilesTotalSize > MAX_TOTAL_SIZE_BYTES) {
      setErrorMsg('Total size limit exceeded — you can upload up to 350 MB in total.');
      e.target.value = '';
      return;
    }

    const category = selectedCategory;
    const maxForCategory = MAX_FILE_SIZE_BYTES[category];
    const oversized = newFiles.filter((f) => f.size > maxForCategory);
    if (oversized.length > 0) {
      const maxMB = (maxForCategory / (1024 * 1024)).toFixed(0);
      setErrorMsg(
        `${oversized.length > 1 ? 'Some files are' : `"${oversized[0].name}" is`} too large — ` +
        `maximum allowed size for ${CATEGORY_META[category].label} is ${maxMB} MB per file.`
      );
      e.target.value = '';
      return;
    }

    if (category === 'PDF' || category === 'IMAGE') {
      // Instant, exact, no upload needed yet — same as before.
      const processed: UploadedFile[] = [];
      for (const file of newFiles) {
        const id = Math.random().toString(36).slice(2);
        if (category === 'IMAGE') {
          processed.push({ id, file, category, pageCount: 1, totalPages: 1, copies: 1, estimated: false });
        } else {
          const { pageCount, estimated, pdfError } = await resolvePdfPageCount(file);
          processed.push({ id, file, category, pageCount, totalPages: pageCount, copies: 1, estimated, pdfError });
        }
      }
      setFiles((prev) => [...prev, ...processed]);
      e.target.value = '';
      return;
    }

    // PPT / DOC: upload immediately and create a COUNTING job so the Pi can
    // convert it and write back the real page count. Files are added to
    // the list right away showing a "counting..." state, then updated by
    // the realtime subscription above once the Pi finishes.
    for (const file of newFiles) {
      const localId = Math.random().toString(36).slice(2);
      setFiles((prev) => [
        ...prev,
        { id: localId, file, category, pageCount: 0, totalPages: 0, copies: 1, estimated: false, counting: true, countingStartedAt: Date.now() },
      ]);

      try {
        const path = `${printerId}/${Date.now()}_${file.name}`;
        const { error: uploadError } = await supabase.storage.from('print-files').upload(path, file, { upsert: false });
        if (uploadError) throw uploadError;

        const { data: jobRow, error: insertError } = await supabase
          .from('print_jobs')
          .insert({
            printer_id: printerId,
            file_type: category,
            file_name: file.name,
            storage_path: path,
            pages_count: 0,
            amount_paid: 0,
            status: 'COUNTING',
          })
          .select('id')
          .single();
        if (insertError) throw insertError;

        setFiles((prev) => prev.map((f) => (f.id === localId ? { ...f, jobId: jobRow.id, storagePath: path } : f)));
      } catch (err) {
        console.error('Failed to upload/queue file for counting:', err);
        setFiles((prev) => prev.filter((f) => f.id !== localId));
        setErrorMsg(`Couldn't upload ${file.name} — please try again.`);
      }
    }

    e.target.value = '';
  };

  const updatePageCount = (id: string, newCount: number) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, pageCount: Math.max(1, Math.round(newCount) || 1) } : f))
    );
  };

  const updateCopies = (id: string, newCopies: number) => {
    const clamped = Math.min(MAX_COPIES, Math.max(1, Math.round(newCopies) || 1));
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, copies: clamped } : f)));
  };

  const updatePageRange = (id: string, rawInput: string) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const { pages, error } = parsePageRange(rawInput, f.totalPages);
        if (error) {
          return { ...f, pageRangeError: error }; // keep previous valid pageCount/pageRange until fixed
        }
        if (pages.length === 0) {
          // Empty input — back to printing everything.
          return { ...f, pageRange: undefined, pageRangeError: undefined, pageCount: f.totalPages };
        }
        return { ...f, pageRange: pages.join(','), pageRangeError: undefined, pageCount: pages.length };
      })
    );
  };

  // Shared cleanup: fetches converted_pdf_path (only known server-side,
  // written by the Pi during counting) before deleting, so a removed PPT/
  // DOC doesn't leave a converted PDF orphaned in Storage on top of the
  // original upload.
  const deleteJobAndFiles = async (jobId: string, storagePath?: string) => {
    try {
      const { data: row } = await supabase.from('print_jobs').select('converted_pdf_path').eq('id', jobId).single();
      await supabase.from('print_jobs').delete().eq('id', jobId);
      const pathsToRemove = [storagePath, row?.converted_pdf_path].filter(Boolean) as string[];
      if (pathsToRemove.length > 0) {
        await supabase.storage.from('print-files').remove(pathsToRemove);
      }
    } catch (err) {
      console.error('Failed to clean up removed file:', err);
    }
  };

  const removeFile = async (id: string) => {
    const item = files.find((f) => f.id === id);
    setFiles((prev) => prev.filter((f) => f.id !== id));

    // PPT/DOC files that were already uploaded (jobId set) need their
    // storage object(s) and print_jobs row cleaned up — otherwise a "wrong
    // file, remove it" click would leave an orphaned upload sitting in
    // Storage and a dead COUNTING/PENDING row in the database forever.
    if (item?.jobId) {
      await deleteJobAndFiles(item.jobId, item.storagePath);
    }
  };

  const clearAllFiles = async () => {
    const toClean = files.filter((f) => f.jobId);
    setFiles([]);
    for (const item of toClean) {
      await deleteJobAndFiles(item.jobId!, item.storagePath);
    }
  };

  const anyFileStillCounting = files.some((f) => f.counting);
  const anyPageRangeError = files.some((f) => f.pageRangeError);

  const getItemUnitPrice = (item: UploadedFile) => (item.category === 'BLANK' ? BLANK_COST_PER_PAGE : COST_PER_PAGE);
  const getItemTotalPages = (item: UploadedFile) => item.pageCount * item.copies;
  const getPrintedPages = () => files.filter((f) => f.category !== 'BLANK').reduce((acc, f) => acc + getItemTotalPages(f), 0);
  const getBlankPages = () => files.filter((f) => f.category === 'BLANK').reduce((acc, f) => acc + getItemTotalPages(f), 0);
  const getTotalPages = () => getPrintedPages() + getBlankPages();
  const getTotalCost = () => files.reduce((acc, f) => acc + getItemTotalPages(f) * getItemUnitPrice(f), 0);
  const getTotalSizeMB = () => (files.reduce((acc, f) => acc + (f.file?.size || 0), 0) / (1024 * 1024)).toFixed(2);

  // Uploads a file, then verifies the byte count that actually landed in
  // Storage matches the original file exactly. Some mobile browsers
  // (aggressive background-tab throttling / OEM browsers like certain
  // Vivo/IQOO/Brave builds) can report an upload as successful while the
  // data was actually truncated mid-transfer — the file "exists" but is
  // corrupted. Left unchecked, the Pi would later download that broken
  // file, CUPS/the printer driver might still accept it without erroring,
  // and the job would get marked COMPLETED despite nothing valid ever
  // printing. Retries once (a fresh attempt on a flaky connection often
  // just works), then fails loudly rather than silently continuing with
  // bad data.
  const uploadFileVerified = async (path: string, file: File): Promise<void> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error: uploadError } = await supabase.storage.from('print-files').upload(path, file, { upsert: attempt > 1 });
      if (uploadError) throw uploadError;

      const { data: listing, error: listError } = await supabase.storage
        .from('print-files')
        .list(path.substring(0, path.lastIndexOf('/')), { search: path.substring(path.lastIndexOf('/') + 1) });
      const uploadedSize = listing?.[0]?.metadata?.size;

      if (!listError && uploadedSize === file.size) return; // verified good

      console.error(`Upload verification failed on attempt ${attempt}: expected ${file.size} bytes, got ${uploadedSize}`);
      if (attempt === 2) {
        throw new Error(`The uploaded file appears corrupted or incomplete (this can happen on some mobile browsers) — please try again, or try a different browser if this keeps happening.`);
      }
    }
  };

  const handleProceedToCheckout = async () => {
    setErrorMsg(null);
    setIsUploading(true);
    try {
      const jobIds: string[] = [];

      for (const item of files) {
        if (item.jobId) {
          // PPT/DOC already uploaded + counted (or manually corrected after
          // a COUNT_FAILED). Sync whatever page count is currently shown —
          // covers the case where the person edited a failed-count fallback
          // — so the database (which the payment amount is computed from)
          // matches exactly what they're about to see on the payment screen.
          const amount = item.pageCount * item.copies * getItemUnitPrice(item);
          const { error: updateError } = await supabase
            .from('print_jobs')
            .update({ pages_count: item.pageCount, copies: item.copies, amount_paid: amount, status: 'PENDING', page_range: item.pageRange || null })
            .eq('id', item.jobId);
          if (updateError) throw updateError;
          jobIds.push(item.jobId);
          continue;
        }

        if (item.category === 'BLANK') {
          // No file at all — nothing to upload, straight to an insert.
          const amount = item.pageCount * item.copies * BLANK_COST_PER_PAGE;
          const { data: jobRow, error: insertError } = await supabase
            .from('print_jobs')
            .insert({
              printer_id: printerId,
              file_type: 'BLANK',
              file_name: `Blank pages x${item.pageCount}`,
              storage_path: '',
              pages_count: item.pageCount,
              copies: item.copies,
              amount_paid: amount,
              status: 'PENDING',
            })
            .select('id')
            .single();
          if (insertError) throw insertError;
          jobIds.push(jobRow.id);
          continue;
        }

        // PDF / IMAGE: not uploaded yet, do it now.
        const path = `${printerId}/${Date.now()}_${item.file!.name}`;
        await uploadFileVerified(path, item.file!);

        const amount = item.pageCount * item.copies * getItemUnitPrice(item);

        const { data: jobRow, error: insertError } = await supabase
          .from('print_jobs')
          .insert({
            printer_id: printerId,
            file_type: item.category,
            file_name: item.file!.name,
            storage_path: path,
            pages_count: item.pageCount,
            copies: item.copies,
            amount_paid: amount,
            status: 'PENDING',
            page_range: item.pageRange || null,
          })
          .select('id')
          .single();
        if (insertError) throw insertError;

        jobIds.push(jobRow.id);
      }

      setPendingJobIds(jobIds);
      setStep('checkout');
    } catch (err) {
      console.error(err);
      setErrorMsg('Something went wrong uploading your files. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRazorpayPayment = async () => {
    setErrorMsg(null);
    setIsProcessingPayment(true);

    try {
      const res = await fetch('/api/create-razorpay-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: pendingJobIds }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Order creation failed');
      }
      const orderData = await res.json();

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: 'INR',
        name: 'S.py - Printer World',
        description: `Print Payment (${getTotalPages()} Pages)`,
        order_id: orderData.order_id,
        handler: async function (response: any) {
          try {
            const verifyRes = await fetch('/api/verify-razorpay-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok || !verifyData.success) {
              throw new Error('Verification failed');
            }
            setStep('success');
          } catch (err) {
            console.error(err);
            setErrorMsg(
              'Payment went through but verification failed. Please contact support with your payment ID: ' + response.razorpay_payment_id
            );
          } finally {
            setIsProcessingPayment(false);
          }
        },
        modal: {
          ondismiss: function () {
            setIsProcessingPayment(false);
          },
        },
        theme: { color: '#0dcaf0' },
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function () {
        setErrorMsg('Payment failed. Please try again.');
        setIsProcessingPayment(false);
      });
      rzp.open();
    } catch (err) {
      console.error(err);
      setErrorMsg('Failed to start payment. Please try again.');
      setIsProcessingPayment(false);
    }
  };

  const resetToUpload = () => {
    setFiles([]);
    setPendingJobIds([]);
    setSelectedCategory(null);
    setStep('upload');
  };

  // 1. SPLASH SCREEN — video only. If the video fails to load, fall back to
  // the logo image alone (still no extra text) rather than a broken screen.
  if (showSplash) {
    return (
      <div className="splash-screen position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center">
        {!videoFailed ? (
          <video
            autoPlay
            muted
            playsInline
            preload="auto"
            className="mw-100 mh-100"
            src="/spy_logo.mp4"
            onEnded={() => setShowSplash(false)}
            onError={() => setVideoFailed(true)}
          />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src="/spy-logo.png" alt="S.py Printing World" style={{ maxWidth: '70%', maxHeight: '70%' }} />
        )}
        <style jsx global>{splashStyles}</style>
      </div>
    );
  }

  // While we don't yet know the printer's status, don't claim it's offline —
  // just show a neutral "checking" state and keep buttons disabled only
  // for that reason (with a spinner), not silently forever.
  const heartbeatStale =
    !printerStatus?.last_heartbeat ||
    Date.now() - new Date(printerStatus.last_heartbeat).getTime() > HEARTBEAT_STALE_MS;
  const printerOffline = !statusLoading && !statusError && (heartbeatStale || !printerStatus?.pi_internet_online);
  // Separate from internet connectivity — the Pi itself can be online while
  // the printer's USB cable has been unplugged (accidentally, or someone
  // swapping in their own device). Previously this flag was fetched but
  // never actually checked anywhere in the UI.
  const printerDisconnected =
    !statusLoading && !statusError && !heartbeatStale && !!printerStatus && !printerStatus.pi_printer_connected;
  const lowPaper = !!printerStatus && printerStatus.paper_remaining < LOW_PAPER_THRESHOLD;
  const printerDisabled = !!printerStatus && !printerStatus.is_enabled;
  const canUpload =
    !statusLoading && !statusError && !printerOffline && !printerDisconnected && !lowPaper && !printerDisabled;

  // 2. MAIN DASHBOARD
  return (
    <div className="kiosk-bg min-vh-100 text-light d-flex flex-column align-items-center p-3 p-md-4">
      <header className="w-100 text-center pb-3 mb-4" style={{ maxWidth: '720px' }}>
        <div className="d-flex align-items-center justify-content-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/spy-logo.png" alt="S.py Printing World" style={{ height: '64px', width: 'auto' }} />
        </div>

        <div className="mt-3 d-flex flex-wrap justify-content-center gap-2">
          {statusLoading ? (
            <span className="status-pill status-pill-neutral">
              <span className="spinner-border spinner-border-sm me-2" role="status" />
              Checking printer status...
            </span>
          ) : statusError ? (
            <span className="text-danger small fw-semibold">{statusError}</span>
          ) : printerOffline ? (
            <span className="status-pill status-pill-red">
              <i className="bi bi-wifi-off me-1"></i> No internet connectivity of printer, please wait to establish the internet
            </span>
          ) : printerDisconnected ? (
            <span className="status-pill status-pill-red">
              <i className="bi bi-usb-plug-fill me-1"></i> Printer not connected, please wait
            </span>
          ) : printerDisabled ? (
            <span className="status-pill status-pill-neutral">
              <i className="bi bi-pause-circle-fill me-1"></i> Printer temporarily disabled by admin
            </span>
          ) : lowPaper ? (
            <span className="status-pill status-pill-amber">
              <i className="bi bi-exclamation-triangle-fill me-1"></i> Paper count low: Please wait until refill
            </span>
          ) : (
            <span className="status-pill status-pill-green">
              <i className="bi bi-check-circle-fill me-1"></i> Printer Ready ({printerStatus?.paper_remaining} pages remaining)
            </span>
          )}
        </div>
      </header>

      {errorMsg && (
        <div className="alert alert-danger w-100" style={{ maxWidth: '720px' }} role="alert">
          {errorMsg}
        </div>
      )}

      <main className="w-100" style={{ maxWidth: '720px' }}>
        {step === 'upload' && (
          <div className="d-flex flex-column gap-4">
            {!selectedCategory && (
              <>
                <p className="text-center text-secondary small mb-0">Choose what you'd like to print</p>
                <div className="row g-3">
                  {(Object.keys(CATEGORY_META) as Category[]).map((cat) => {
                    const meta = CATEGORY_META[cat];
                    return (
                      <div className="col-6 col-md-4 col-lg-3" key={cat}>
                        <button
                          disabled={!canUpload}
                          onClick={() => openPicker(cat)}
                          className="category-card w-100 p-3 d-flex flex-column align-items-center gap-2 border-0"
                          style={{ background: meta.gradient }}
                        >
                          <i className={`bi ${meta.icon} fs-2`}></i>
                          <span className="small fw-semibold">{cat === 'BLANK' ? meta.label : `Upload ${meta.label}`}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="d-none"
              accept={selectedCategory ? CATEGORY_META[selectedCategory].accept : undefined}
              onChange={handleFileChange}
            />

            {selectedCategory && (
              <div className="card kiosk-card">
                <div className="card-header d-flex justify-content-between align-items-center border-secondary">
                  <button
                    onClick={() => {
                      setSelectedCategory(null);
                      clearAllFiles();
                    }}
                    className="btn btn-link text-secondary text-decoration-none p-0 d-flex align-items-center gap-1"
                  >
                    <i className="bi bi-arrow-left"></i>
                    <span className="small">Back</span>
                  </button>
                  <div className="d-flex align-items-center gap-2">
                    <i className={`bi ${CATEGORY_META[selectedCategory].icon} text-info`}></i>
                    <h6 className="mb-0 fw-bold">
                      {selectedCategory === 'BLANK'
                        ? 'Blank Pages'
                        : files.length > 0
                          ? `Selected Files (${files.length})`
                          : `Add your ${CATEGORY_META[selectedCategory].label} files`}
                    </h6>
                  </div>
                </div>

                {selectedCategory === 'BLANK' && (
                  <div className="card-body">
                    <BlankPagesPicker onAdd={addBlankPages} unitPrice={BLANK_COST_PER_PAGE} />
                  </div>
                )}

                {files.length > 0 && (
                  <div className="card-body p-2" style={{ maxHeight: '260px', overflowY: 'auto' }}>
                    {files.map((item) => (
                      <div key={item.id} className="file-row p-2 rounded mb-2">
                        <div className="d-flex justify-content-between align-items-center">
                          <div className="d-flex align-items-center gap-2 text-truncate me-2">
                            <span className="badge bg-info text-dark">{item.category}</span>
                            <span className="small text-truncate">
                              {item.category === 'BLANK' ? `Blank pages x${item.pageCount}` : item.file?.name}
                            </span>
                          </div>
                          <div className="d-flex align-items-center gap-2">
                            {item.counting ? (
                              <span className="small text-info d-flex align-items-center gap-1">
                                <span className="spinner-border spinner-border-sm" role="status" />
                                Counting pages...
                              </span>
                            ) : item.estimated ? (
                              <div className="d-flex align-items-center gap-1">
                                <input
                                  type="number"
                                  min={1}
                                  value={item.pageCount}
                                  onChange={(e) => updatePageCount(item.id, Number(e.target.value))}
                                  className="form-control form-control-sm bg-dark text-light border-secondary"
                                  style={{ width: '60px' }}
                                />
                                <span className="small text-secondary">pg (est.)</span>
                              </div>
                            ) : (
                              <span className="small text-secondary">
                                {item.category === 'BLANK'
                                  ? `${item.pageCount} sheet${item.pageCount === 1 ? '' : 's'}`
                                  : item.pageRange
                                    ? `${item.pageCount} of ${item.totalPages} pg`
                                    : `${item.pageCount} pg`}
                              </span>
                            )}
                            <button
                              onClick={() => removeFile(item.id)}
                              disabled={item.counting}
                              className="btn btn-sm btn-outline-danger border-0"
                            >
                              <i className="bi bi-trash-fill"></i>
                            </button>
                          </div>
                        </div>
                        {!item.counting && !item.countFailed && (
                          <div className="mt-2 d-flex align-items-center gap-2">
                            <span className="small text-secondary">Copies:</span>
                            <button
                              onClick={() => updateCopies(item.id, item.copies - 1)}
                              disabled={item.copies <= 1}
                              className="btn btn-sm btn-outline-secondary rounded-circle p-0"
                              style={{ width: '26px', height: '26px', lineHeight: 1 }}
                            >
                              <i className="bi bi-dash"></i>
                            </button>
                            <input
                              type="number"
                              min={1}
                              max={MAX_COPIES}
                              value={item.copies}
                              onChange={(e) => updateCopies(item.id, Number(e.target.value))}
                              className="form-control form-control-sm bg-dark text-light border-secondary text-center"
                              style={{ width: '50px' }}
                            />
                            <button
                              onClick={() => updateCopies(item.id, item.copies + 1)}
                              disabled={item.copies >= MAX_COPIES}
                              className="btn btn-sm btn-outline-secondary rounded-circle p-0"
                              style={{ width: '26px', height: '26px', lineHeight: 1 }}
                            >
                              <i className="bi bi-plus"></i>
                            </button>
                            {item.copies > 1 && (
                              <span className="small text-info">
                                = {getItemTotalPages(item)} {item.category === 'BLANK' ? 'sheets' : 'pages'} total, ₹{(getItemTotalPages(item) * getItemUnitPrice(item)).toFixed(2)}
                              </span>
                            )}
                          </div>
                        )}
                        {item.countFailed && (
                          <p className="small text-warning mb-0 mt-1">
                            <i className="bi bi-info-circle me-1"></i>
                            The printer couldn't read this file to count its pages — please check and correct the number above before paying.
                          </p>
                        )}
                        {!item.countFailed && item.estimated && (
                          <p className="small text-warning mb-0 mt-1">
                            <i className="bi bi-info-circle me-1"></i>
                            {item.pdfError || "We couldn't read the exact page count for this file — please check and correct the number above before paying."}
                          </p>
                        )}
                        {item.counting && item.countingStartedAt && Date.now() - item.countingStartedAt > 45000 && (
                          <p className="small text-warning mb-0 mt-1">
                            <i className="bi bi-hourglass-split me-1"></i>
                            Taking longer than usual — the printer may be busy or briefly offline. Still waiting...
                          </p>
                        )}
                        {!item.counting && !item.countFailed && !item.estimated && item.category !== 'IMAGE' && item.category !== 'BLANK' && item.totalPages > 1 && (
                          <div className="mt-2">
                            <input
                              type="text"
                              placeholder={`Print specific pages (e.g. 1-5, 8, 12-15) — leave blank for all ${item.totalPages}`}
                              defaultValue={item.pageRange ? item.pageRange.split(',').join(', ') : ''}
                              onChange={(e) => updatePageRange(item.id, e.target.value)}
                              className="form-control form-control-sm bg-dark text-light border-secondary"
                            />
                            {item.pageRangeError && (
                              <p className="small text-danger mb-0 mt-1">
                                <i className="bi bi-exclamation-circle me-1"></i>
                                {item.pageRangeError}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="card-footer border-secondary d-flex flex-column gap-2">
                  {selectedCategory !== 'BLANK' && (
                    <>
                      <button onClick={() => openPicker(selectedCategory)} className="btn btn-outline-info fw-semibold w-100 py-2">
                        <i className="bi bi-plus-lg me-2"></i>
                        {files.length > 0 ? `Add more ${CATEGORY_META[selectedCategory].label} files` : `Select ${CATEGORY_META[selectedCategory].label} files`}
                      </button>
                      <p className="small text-secondary text-center mb-0">
                        Max {(MAX_FILE_SIZE_BYTES[selectedCategory] / (1024 * 1024)).toFixed(0)} MB per file, 350 MB total per order
                      </p>
                    </>
                  )}

                  {files.length > 0 && (
                    <>
                      {files.some((f) => f.category !== 'BLANK') && (
                        <div className="text-end small text-secondary">Size: {getTotalSizeMB()} / 350 MB</div>
                      )}
                      <button
                        onClick={handleProceedToCheckout}
                        disabled={!canUpload || isUploading || anyFileStillCounting || anyPageRangeError}
                        className="btn btn-print fw-bold w-100 py-2"
                      >
                        {isUploading ? (
                          <>
                            <span className="spinner-border spinner-border-sm me-2" role="status" />
                            Uploading files...
                          </>
                        ) : anyFileStillCounting ? (
                          <>
                            <span className="spinner-border spinner-border-sm me-2" role="status" />
                            Counting pages...
                          </>
                        ) : (
                          <>
                            <i className="bi bi-printer-fill me-2"></i> Proceed to Print Preview
                          </>
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'checkout' && (
          <div className="d-flex flex-column gap-3">
            <button
              onClick={() => setStep('upload')}
              disabled={isProcessingPayment}
              className="btn btn-link text-secondary text-decoration-none p-0 text-start"
            >
              <i className="bi bi-arrow-left me-1"></i> Back to File Upload
            </button>

            <div className="card kiosk-card">
              <div className="card-body">
                <h5 className="card-title text-info fw-bold mb-3">Final Print Breakdown</h5>
                <div className="d-flex justify-content-between border-bottom border-secondary pb-2 mb-2">
                  <span className="text-secondary">Total Files Selected:</span>
                  <span className="fw-semibold">{files.length}</span>
                </div>
                {getPrintedPages() > 0 && (
                  <div className="d-flex justify-content-between border-bottom border-secondary pb-2 mb-2">
                    <span className="text-secondary">Printed Pages ({getPrintedPages()} × ₹{COST_PER_PAGE.toFixed(2)}):</span>
                    <span className="fw-semibold">₹{(getPrintedPages() * COST_PER_PAGE).toFixed(2)}</span>
                  </div>
                )}
                {getBlankPages() > 0 && (
                  <div className="d-flex justify-content-between border-bottom border-secondary pb-2 mb-3">
                    <span className="text-secondary">Blank Sheets ({getBlankPages()} × ₹{BLANK_COST_PER_PAGE.toFixed(2)}):</span>
                    <span className="fw-semibold">₹{(getBlankPages() * BLANK_COST_PER_PAGE).toFixed(2)}</span>
                  </div>
                )}

                <div className="d-flex justify-content-between align-items-center mb-3">
                  <span className="h6 mb-0">Total Payable Amount:</span>
                  <span className="h4 text-success fw-bold mb-0">₹{getTotalCost().toFixed(2)}</span>
                </div>

                <button
                  onClick={handleRazorpayPayment}
                  disabled={isProcessingPayment}
                  className="btn btn-success fw-bold w-100 py-2"
                >
                  {isProcessingPayment ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-2" role="status" />
                      Connecting Razorpay...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-credit-card-fill me-2"></i>
                      Pay ₹{getTotalCost().toFixed(2)} Now
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="card kiosk-card">
              <div className="card-body">
                <h6 className="card-subtitle mb-2 text-secondary text-uppercase small">
                  Live Printer Queue ({activeQueue.length} ahead of you)
                </h6>
                {activeQueue.length === 0 ? (
                  <p className="small text-muted fst-italic mb-0">No one in line. Your job will print immediately after payment!</p>
                ) : (
                  <div className="d-flex flex-column gap-2" style={{ maxHeight: '150px', overflowY: 'auto' }}>
                    {activeQueue.map((q) => (
                      <div key={q.id} className="d-flex justify-content-between align-items-center small file-row p-2 rounded">
                        <span className="text-truncate">{q.file_name}</span>
                        <span className="badge bg-info text-dark">{q.pages_count} pages</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="card kiosk-card text-center p-4">
            <div className="card-body">
              <i className="bi bi-check-circle-fill text-success fs-1 mb-3"></i>
              <h3 className="fw-bold">Payment Successful!</h3>
              <p className="text-info mb-4">Your print is getting ready on the printer...</p>
              <button onClick={resetToUpload} className="btn btn-print fw-bold w-100 py-2">
                <i className="bi bi-arrow-repeat me-2"></i> Continue to Print More
              </button>
            </div>
          </div>
        )}
      </main>
      <style jsx global>{dashboardStyles}</style>
    </div>
  );
}

const splashStyles = `
  .splash-screen {
    background: radial-gradient(circle at 50% 40%, #101820 0%, #000000 80%);
  }
  .logo-badge {
    background: linear-gradient(135deg, #36d1dc, #0dcaf0);
    color: #041019;
    border-radius: 10px;
  }
  .spy-gradient-text {
    background: linear-gradient(90deg, #36d1dc, #5b86e5);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
`;

const dashboardStyles = `
  .kiosk-bg {
    background: radial-gradient(circle at 50% 0%, #172029 0%, #0a0e12 60%);
  }
  .logo-badge {
    background: linear-gradient(135deg, #36d1dc, #0dcaf0);
    color: #041019;
    border-radius: 10px;
  }
  .spy-gradient-text {
    background: linear-gradient(90deg, #36d1dc, #5b86e5);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 600;
    border: 1px solid transparent;
  }
  .status-pill-green { background: rgba(25,135,84,0.15); color: #4ade80; border-color: rgba(25,135,84,0.4); }
  .status-pill-red { background: rgba(220,53,69,0.15); color: #f87171; border-color: rgba(220,53,69,0.4); }
  .status-pill-amber { background: rgba(255,193,7,0.15); color: #fbbf24; border-color: rgba(255,193,7,0.4); }
  .status-pill-neutral { background: rgba(148,163,184,0.15); color: #cbd5e1; border-color: rgba(148,163,184,0.35); }

  .category-card {
    border-radius: 16px;
    color: #fff;
    box-shadow: 0 8px 20px rgba(0,0,0,0.35);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .category-card:hover:not(:disabled) {
    transform: translateY(-4px);
    box-shadow: 0 12px 26px rgba(0,0,0,0.45);
  }
  .category-card:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .kiosk-card {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    backdrop-filter: blur(6px);
  }
  .file-row {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
  }

  .btn-print {
    background: linear-gradient(135deg, #36d1dc, #5b86e5);
    border: none;
    color: #041019;
  }
  .btn-print:hover {
    filter: brightness(1.08);
    color: #041019;
  }
`;