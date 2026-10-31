'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { computeJobAmount, pricingFromPrinter, type AiMode } from '@/lib/pricing';
import PiMonitor, { type PiTelemetry } from './PiMonitor';

declare global {
  interface Window {
    Razorpay: any;
  }
}

// ---- Config ---------------------------------------------------------------

const MAX_TOTAL_SIZE_BYTES = 350 * 1024 * 1024;
const MAX_COPIES = 20;
const LOW_PAPER_THRESHOLD = 10;
const HEARTBEAT_STALE_MS = 20000; // the Pi heartbeats every ~5s; older than this means it's offline
const AI_SLOW_MS = 120000;

type Category = 'PDF' | 'IMAGE' | 'PPT' | 'DOC' | 'BLANK';

// Images get a small cap: they're rasterised directly by the printer driver, unlike documents.
const MAX_FILE_SIZE_BYTES: Record<Category, number> = {
  IMAGE: 25 * 1024 * 1024,
  PDF: 100 * 1024 * 1024,
  PPT: 100 * 1024 * 1024,
  DOC: 100 * 1024 * 1024,
  BLANK: Infinity,
};

interface PrinterStatus {
  id: string;
  name: string;
  is_enabled: boolean;
  paper_remaining: number;
  pi_internet_online: boolean;
  pi_printer_connected: boolean;
  last_heartbeat: string;
  cost_per_page: number;
  duplex_cost_per_sheet: number;
  blank_cost_per_page: number;
  green_ai_fee: number;
  cheatsheet_price: number;
  execsum_price: number;
  ai_ready: boolean; // eco-ink + Green AI available on this printer
  slm_ready: boolean; // cheat sheet / executive summary available on this printer
}

type AiState = 'idle' | 'processing' | 'ready' | 'failed';

interface UploadedFile {
  id: string;
  file: File | null; // null for blank pages
  category: Category; // the file's own type (for summaries: the source document type)
  pageCount: number; // billed pages per copy
  totalPages: number; // pages in the source document
  copies: number;
  duplex: boolean;
  ecoInk: boolean;
  estimated: boolean;
  pdfError?: string;
  pageRange?: string; // expanded list "1,3,5,6"; for summaries it selects the source pages
  pageRangeError?: string;
  jobId?: string;
  storagePath?: string;
  counting?: boolean;
  countingStartedAt?: number;
  countFailed?: boolean;
  rejected?: string; // the printer refused this file (unsafe, ink bomb, unreadable): shown to the student, blocks checkout
  // Green AI
  greenAi: boolean;
  greenReady: boolean;
  greenPages?: number;
  greenSkipped?: boolean;
  // AI work on the Pi (Green AI or a summary)
  aiMode?: AiMode;
  aiState: AiState;
  aiSubmitted?: boolean;
  aiStartedAt?: number;
  aiTelemetry?: PiTelemetry | null;
  aiScore?: number;
  aiNote?: string;
  aiError?: string;
}

interface JobRow {
  id: string;
  status: string;
  pages_count: number;
  base_pages_count: number | null;
  ai_pages_count: number | null;
  ai_score: number | null;
  ai_note: string | null;
  ai_error: string | null;
  ai_telemetry: PiTelemetry | null;
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

const AI_META: Record<AiMode, { label: string; blurb: string; pages: number; gradient: string; verb: string }> = {
  CHEATSHEET: {
    label: 'Cheat Sheet',
    blurb: 'Your whole document on one page',
    pages: 1,
    gradient: 'linear-gradient(135deg,#7f5af0,#2cb67d)',
    verb: 'cheat sheet',
  },
  EXECSUM: {
    label: 'Executive Summary',
    blurb: 'Exactly 3 pages, printed double-sided',
    pages: 3,
    gradient: 'linear-gradient(135deg,#ff8906,#e53170)',
    verb: 'executive summary',
  },
};

const SOURCE_TYPES: Category[] = ['PDF', 'PPT', 'DOC'];

const newFile = (o: Partial<UploadedFile> & Pick<UploadedFile, 'id' | 'category'>): UploadedFile => ({
  file: null,
  pageCount: 0,
  totalPages: 0,
  copies: 1,
  duplex: false,
  ecoInk: false,
  estimated: false,
  greenAi: false,
  greenReady: false,
  aiState: 'idle',
  ...o,
});

// "1-5, 8, 12-15" -> sorted unique page numbers. Stored expanded so billing and printing can never disagree.
function parsePageRange(input: string, totalPages: number): { pages: number[]; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { pages: [] };
  const selected = new Set<number>();
  for (const token of trimmed.split(',').map((t) => t.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    const single = token.match(/^(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start < 1 || end > totalPages || start > end) {
        return { pages: [], error: `"${token}" is not a valid range for this ${totalPages}-page document.` };
      }
      for (let p = start; p <= end; p++) selected.add(p);
    } else if (single) {
      const page = parseInt(single[1], 10);
      if (page < 1 || page > totalPages) return { pages: [], error: `Page ${page} doesn't exist — this document has ${totalPages} pages.` };
      selected.add(page);
    } else {
      return { pages: [], error: `"${token}" isn't a valid page or range (try something like "1-5, 8, 12-15").` };
    }
  }
  return { pages: Array.from(selected).sort((a, b) => a - b) };
}

// PDFs are counted in the browser with a self-hosted pdf.js worker (a CDN worker failed silently on some networks).
async function getPdfPageCount(file: File): Promise<number> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  return pdf.numPages;
}

async function resolvePdfPageCount(file: File): Promise<{ pageCount: number; estimated: boolean; pdfError?: string }> {
  try {
    return { pageCount: await getPdfPageCount(file), estimated: false };
  } catch (err) {
    console.error('PDF page count failed:', err);
    return { pageCount: 1, estimated: true, pdfError: 'Could not read page count from this PDF — please re-check it before paying.' };
  }
}

function BlankPagesPicker({ onAdd, unitPrice }: { onAdd: (qty: number) => void; unitPrice: number }) {
  const [qty, setQty] = useState(1);
  return (
    <div className="d-flex flex-column gap-3 align-items-center py-3">
      <p className="text-secondary small mb-0">How many blank sheets do you need?</p>
      <div className="d-flex align-items-center gap-3">
        <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="btn btn-outline-secondary rounded-circle" style={{ width: 44, height: 44 }}>
          <i className="bi bi-dash-lg"></i>
        </button>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.round(Number(e.target.value)) || 1))}
          className="form-control form-control-lg text-center bg-dark text-light border-secondary"
          style={{ width: 90 }}
        />
        <button onClick={() => setQty((q) => q + 1)} className="btn btn-outline-secondary rounded-circle" style={{ width: 44, height: 44 }}>
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

function AiTrustNote() {
  return (
    <div className="ai-trust small">
      <i className="bi bi-cpu-fill me-2"></i>
      <span>
        <strong>On-device AI.</strong> It runs on this printer's own processor — your document isn't sent to ChatGPT or any other cloud AI
        service. Every summary shows a <strong>grounding check</strong>: how much of the AI-written text's key terms actually appear in your
        document.
      </span>
    </div>
  );
}

// ---- Page -------------------------------------------------------------------

export default function KioskPage() {
  const params = useParams();
  const printerId = params?.printer_id as string;

  const [showSplash, setShowSplash] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);

  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [aiMode, setAiMode] = useState<AiMode | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [step, setStep] = useState<'upload' | 'checkout' | 'success'>('upload');

  const [activeQueue, setActiveQueue] = useState<QueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<UploadedFile[]>([]);
  filesRef.current = files;

  const cfg = pricingFromPrinter(printerStatus);
  const aiReady = !!printerStatus?.ai_ready;
  const slmReady = !!printerStatus?.slm_ready;

  const priceItem = (item: UploadedFile, duplexOverride?: boolean) =>
    computeJobAmount(
      {
        pages: item.pageCount,
        copies: item.copies,
        fileType: item.category,
        duplex: duplexOverride !== undefined ? duplexOverride : item.duplex,
        aiMode: item.aiMode,
        greenApplied: item.greenAi && item.greenReady,
      },
      cfg
    );

  const patchFile = useCallback((id: string, patch: Partial<UploadedFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  // ---- effects ----

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 20000); // safety net if the video's 'ended' never fires
    return () => clearTimeout(t);
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
    const t = setInterval(() => forceTick((n) => n + 1), 5000); // re-evaluates heartbeat staleness
    return () => clearInterval(t);
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

  // One reducer for both realtime events and the polling fallback.
  const applyJobRow = useCallback((row: JobRow) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.jobId !== row.id) return f;
        const working = f.aiState === 'processing' && f.aiSubmitted;

        if (row.status === 'COUNTING') return working ? { ...f, aiTelemetry: row.ai_telemetry ?? f.aiTelemetry } : f;

        if (row.status === 'COUNT_FAILED') {
          if (working) {
            return { ...f, aiState: 'failed', aiTelemetry: null, greenAi: false, aiError: row.ai_error || 'The AI engine could not process this file.' };
          }
          const why = (row.ai_error || '').startsWith('REJECTED:') ? row.ai_error!.slice(9).trim() : "The printer couldn't prepare this file. Remove it and try again, or save it as a PDF first.";
          return { ...f, counting: false, countFailed: false, estimated: false, rejected: why };
        }

        if (row.status === 'PENDING') {
          const base = row.base_pages_count ?? row.pages_count;
          if (working && f.aiMode) {
            return { ...f, aiState: 'ready', aiTelemetry: null, totalPages: base, pageCount: row.pages_count, aiScore: row.ai_score ?? undefined, aiNote: row.ai_note ?? undefined };
          }
          if (working) {
            if (row.ai_pages_count != null) {
              return {
                ...f, aiState: 'ready', aiTelemetry: null, greenReady: true, greenPages: row.ai_pages_count, totalPages: base,
                pageCount: row.ai_pages_count, pageRange: undefined, pageRangeError: undefined, aiNote: row.ai_note ?? undefined,
              };
            }
            return { ...f, aiState: 'idle', aiTelemetry: null, greenAi: false, greenSkipped: true, totalPages: base, pageCount: base, aiNote: row.ai_note ?? undefined };
          }
          if (f.counting) return { ...f, counting: false, countFailed: false, estimated: false, totalPages: base, pageCount: row.pages_count };
        }
        return f;
      })
    );
  }, []);

  useEffect(() => {
    if (!printerId) return;

    const fetchStatus = async () => {
      setStatusLoading(true);
      setStatusError(null);
      const { data, error } = await supabase.from('printers').select('*').eq('id', printerId).single();
      if (error) {
        console.error('Failed to load printer status:', error);
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printers', filter: `id=eq.${printerId}` }, (payload) =>
        setPrinterStatus(payload.new as PrinterStatus)
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs', filter: `printer_id=eq.${printerId}` }, (payload) => {
        const row = payload.new as JobRow;
        if (!row || !row.id) return;
        if (row.status !== 'COUNTING') fetchQueue(); // COUNTING updates are 1/sec telemetry — skip the queue refetch
        applyJobRow(row);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [printerId, fetchQueue, applyJobRow]);

  // Polling fallback so a missed realtime event can't leave the monitor spinning forever.
  const processingKey = files.filter((f) => f.aiState === 'processing' && f.aiSubmitted && f.jobId).map((f) => f.jobId).join(',');
  useEffect(() => {
    if (!processingKey) return;
    const poll = async () => {
      const { data } = await supabase
        .from('print_jobs')
        .select('id, status, pages_count, base_pages_count, ai_pages_count, ai_score, ai_note, ai_error, ai_telemetry')
        .in('id', processingKey.split(','));
      (data as JobRow[] | null)?.forEach(applyJobRow);
    };
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [processingKey, applyJobRow]);

  // ---- helpers that talk to the database ----

  // update() under RLS silently matches 0 rows when it isn't allowed, so make that loud.
  const updateJob = async (jobId: string, patch: Record<string, unknown>) => {
    const { data, error } = await supabase.from('print_jobs').update(patch).eq('id', jobId).select('id');
    if (error) throw error;
    if (!data || data.length === 0) throw new Error('The database refused the update — run the latest migration (db-migration-ai-features.sql).');
  };

  // Uploads then checks the stored size. Non-blocking on mismatch: the check can race storage propagation.
  const uploadFileVerified = async (path: string, file: File) => {
    const { error } = await supabase.storage.from('print-files').upload(path, file, { upsert: false });
    if (error) throw error;
    try {
      const dir = path.substring(0, path.lastIndexOf('/'));
      const { data } = await supabase.storage.from('print-files').list(dir, { search: path.substring(path.lastIndexOf('/') + 1) });
      const size = data?.[0]?.metadata?.size;
      if (size !== undefined && size !== file.size) console.warn(`Upload size mismatch for ${file.name}: ${file.size} vs ${size}`);
    } catch (err) {
      console.warn('Upload verification failed (non-fatal):', err);
    }
  };

  // PDFs aren't uploaded until needed; the AI features need the file on the Pi, so create the job row now (as PENDING so the Pi ignores it).
  const ensureJob = async (item: UploadedFile): Promise<string> => {
    if (item.jobId) return item.jobId;
    const path = `${printerId}/${Date.now()}_${item.file!.name}`;
    await uploadFileVerified(path, item.file!);
    const { data, error } = await supabase
      .from('print_jobs')
      .insert({
        printer_id: printerId,
        file_type: item.category,
        file_name: item.file!.name,
        storage_path: path,
        pages_count: item.pageCount,
        base_pages_count: item.totalPages,
        amount_paid: 0,
        status: 'PENDING',
      })
      .select('id')
      .single();
    if (error) throw error;
    patchFile(item.id, { jobId: data.id, storagePath: path });
    return data.id;
  };

  const resetAiJobFields = { ai_pdf_path: null, ai_pages_count: null, ai_score: null, ai_note: null, ai_error: null, ai_telemetry: null };

  const startAi = async (id: string, kind: 'SUMMARY' | 'GREEN') => {
    const item = filesRef.current.find((f) => f.id === id);
    if (!item) return;
    patchFile(id, { aiState: 'processing', aiSubmitted: false, aiStartedAt: Date.now(), aiTelemetry: null, aiError: undefined, aiNote: undefined, aiScore: undefined });
    try {
      const jobId = await ensureJob(item);
      await updateJob(jobId, {
        ...resetAiJobFields,
        ai_mode: kind === 'SUMMARY' ? item.aiMode : null,
        green_ai: kind === 'GREEN',
        page_range: kind === 'SUMMARY' ? item.pageRange || null : null,
        base_pages_count: item.totalPages,
        eco_ink: item.ecoInk,
        duplex: item.aiMode === 'EXECSUM' ? true : item.duplex,
        copies: item.copies,
        status: 'COUNTING',
      });
      patchFile(id, { aiSubmitted: true });
    } catch (err) {
      console.error(err);
      patchFile(id, { aiState: 'failed', greenAi: kind === 'GREEN' ? false : item.greenAi, aiError: err instanceof Error ? err.message : 'Could not start the AI engine.' });
    }
  };

  const toggleGreen = (id: string, on: boolean) => {
    const f = filesRef.current.find((x) => x.id === id);
    if (!f) return;
    if (!on) {
      patchFile(id, { greenAi: false, pageCount: f.totalPages, aiState: f.aiState === 'failed' ? 'idle' : f.aiState });
    } else if (f.greenReady && f.greenPages) {
      patchFile(id, { greenAi: true, pageCount: f.greenPages, pageRange: undefined, pageRangeError: undefined });
    } else {
      patchFile(id, { greenAi: true, pageRange: undefined, pageRangeError: undefined, pageCount: f.totalPages });
      startAi(id, 'GREEN');
    }
  };

  const deleteJobAndFiles = async (jobId: string, storagePath?: string) => {
    try {
      const { data: row } = await supabase.from('print_jobs').select('converted_pdf_path, ai_pdf_path').eq('id', jobId).single();
      await supabase.from('print_jobs').delete().eq('id', jobId);
      const paths = [storagePath, row?.converted_pdf_path, row?.ai_pdf_path].filter(Boolean) as string[];
      if (paths.length > 0) await supabase.storage.from('print-files').remove(paths);
    } catch (err) {
      console.error('Failed to clean up removed file:', err);
    }
  };

  const removeFile = async (id: string) => {
    const item = files.find((f) => f.id === id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (item?.jobId) await deleteJobAndFiles(item.jobId, item.storagePath);
  };

  const clearAllFiles = async () => {
    const toClean = files.filter((f) => f.jobId);
    setFiles([]);
    for (const item of toClean) await deleteJobAndFiles(item.jobId!, item.storagePath);
  };

  // ---- picking files ----

  const openPicker = (cat: Category) => {
    setSelectedCategory(cat);
    if (cat === 'BLANK') return;
    setTimeout(() => fileInputRef.current?.click(), 0);
  };

  const addBlankPages = (quantity: number) => {
    const qty = Math.max(1, Math.round(quantity) || 1);
    setFiles((prev) => [...prev, newFile({ id: Math.random().toString(36).slice(2), category: 'BLANK', pageCount: qty, totalPages: qty })]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !selectedCategory) return;
    setErrorMsg(null);

    const picked = Array.from(e.target.files);
    const currentSize = files.reduce((acc, f) => acc + (f.file?.size || 0), 0);
    if (currentSize + picked.reduce((acc, f) => acc + f.size, 0) > MAX_TOTAL_SIZE_BYTES) {
      setErrorMsg('Total size limit exceeded — you can upload up to 350 MB in total.');
      e.target.value = '';
      return;
    }

    const category = selectedCategory;
    const maxBytes = MAX_FILE_SIZE_BYTES[category];
    const oversized = picked.filter((f) => f.size > maxBytes);
    if (oversized.length > 0) {
      setErrorMsg(
        `${oversized.length > 1 ? 'Some files are' : `"${oversized[0].name}" is`} too large — maximum for ${CATEGORY_META[category].label} is ${(maxBytes / 1048576).toFixed(0)} MB per file.`
      );
      e.target.value = '';
      return;
    }

    const defaults = { ecoInk: aiReady, aiMode: aiMode ?? undefined, duplex: aiMode === 'EXECSUM' };

    // Every file (PDF, image, PPT, DOC) goes to the printer first: it checks the file is safe, rebuilds it as a clean PDF and counts the pages.
    // Nothing can be paid for until that is done.
    for (const file of picked) {
      const localId = Math.random().toString(36).slice(2);
      setFiles((prev) => [...prev, newFile({ id: localId, file, category, counting: true, countingStartedAt: Date.now(), ...defaults })]);
      try {
        const path = `${printerId}/${Date.now()}_${file.name}`;
        await uploadFileVerified(path, file);
        const { data: jobRow, error } = await supabase
          .from('print_jobs')
          .insert({ printer_id: printerId, file_type: category, file_name: file.name, storage_path: path, pages_count: 0, amount_paid: 0, status: 'COUNTING' })
          .select('id')
          .single();
        if (error) throw error;
        patchFile(localId, { jobId: jobRow.id, storagePath: path });
      } catch (err) {
        console.error('Failed to upload/queue file for counting:', err);
        setFiles((prev) => prev.filter((f) => f.id !== localId));
        setErrorMsg(`Couldn't upload ${file.name} — please try again.`);
      }
    }
    e.target.value = '';
  };

  // ---- per-file edits ----

  const updatePageCount = (id: string, n: number) => patchFile(id, { pageCount: Math.max(1, Math.round(n) || 1) });
  const updateCopies = (id: string, n: number) => patchFile(id, { copies: Math.min(MAX_COPIES, Math.max(1, Math.round(n) || 1)) });

  const updatePageRange = (id: string, raw: string) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const { pages, error } = parsePageRange(raw, f.totalPages);
        if (error) return { ...f, pageRangeError: error };
        const range = pages.length ? pages.join(',') : undefined;
        if (f.aiMode) {
          // The range picks what to summarise; a finished summary no longer matches it.
          return { ...f, pageRange: range, pageRangeError: undefined, aiState: f.aiState === 'ready' ? 'idle' : f.aiState, pageCount: f.aiState === 'ready' ? 0 : f.pageCount };
        }
        return { ...f, pageRange: range, pageRangeError: undefined, pageCount: pages.length || f.totalPages };
      })
    );
  };

  // ---- totals ----

  const anyFileStillCounting = files.some((f) => f.counting);
  const anyRejected = files.some((f) => !!f.rejected);
  const anyPageRangeError = files.some((f) => f.pageRangeError);
  const anyAiBusy = files.some((f) => f.aiState === 'processing');
  const summaryNotReady = files.some((f) => f.aiMode && f.aiState !== 'ready');

  const isAi = (f: UploadedFile) => !!f.aiMode;
  const sumAmount = (list: UploadedFile[]) => list.reduce((acc, f) => acc + priceItem(f), 0);
  const getTotalCost = () => sumAmount(files);
  const getTotalPages = () => files.reduce((acc, f) => acc + f.pageCount * f.copies, 0);
  const getTotalSizeMB = () => (files.reduce((acc, f) => acc + (f.file?.size || 0), 0) / 1048576).toFixed(2);
  const greenFees = files.reduce((acc, f) => acc + (f.greenAi && f.greenReady ? cfg.greenAiFee : 0), 0);

  // ---- checkout ----

  const jobFields = (item: UploadedFile) => ({
    pages_count: item.pageCount,
    copies: item.copies,
    duplex: item.aiMode === 'EXECSUM' ? true : item.duplex,
    eco_ink: item.category !== 'BLANK' && item.ecoInk,
    green_ai: item.greenAi && item.greenReady,
    ai_mode: item.aiMode ?? null,
    page_range: item.greenAi && item.greenReady ? null : item.pageRange || null,
    base_pages_count: item.totalPages,
    amount_paid: priceItem(item),
    status: 'PENDING',
  });

  const handleProceedToCheckout = async () => {
    setErrorMsg(null);
    setIsUploading(true);
    try {
      const jobIds: string[] = [];
      for (const item of files) {
        if (item.jobId) {
          await updateJob(item.jobId, jobFields(item));
          jobIds.push(item.jobId);
        } else if (item.category === 'BLANK') {
          const { data, error } = await supabase
            .from('print_jobs')
            .insert({
              printer_id: printerId,
              file_type: 'BLANK',
              file_name: `Blank pages x${item.pageCount}`,
              storage_path: '',
              ...jobFields(item),
            })
            .select('id')
            .single();
          if (error) throw error;
          jobIds.push(data.id);
        } else {
          const path = `${printerId}/${Date.now()}_${item.file!.name}`;
          await uploadFileVerified(path, item.file!);
          const { data, error } = await supabase
            .from('print_jobs')
            .insert({ printer_id: printerId, file_type: item.category, file_name: item.file!.name, storage_path: path, ...jobFields(item) })
            .select('id')
            .single();
          if (error) throw error;
          jobIds.push(data.id);
        }
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
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Order creation failed');
      const orderData = await res.json();

      const rzp = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: 'INR',
        name: 'S.py - Printer World',
        description: `Print Payment (${getTotalPages()} Pages)`,
        order_id: orderData.order_id,
        handler: async (response: any) => {
          try {
            const verify = await fetch('/api/verify-razorpay-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            const result = await verify.json();
            if (!verify.ok || !result.success) throw new Error('Verification failed');
            setStep('success');
          } catch (err) {
            console.error(err);
            setErrorMsg('Payment went through but verification failed. Please contact support with your payment ID: ' + response.razorpay_payment_id);
          } finally {
            setIsProcessingPayment(false);
          }
        },
        modal: { ondismiss: () => setIsProcessingPayment(false) },
        theme: { color: '#0dcaf0' },
      });
      rzp.on('payment.failed', () => {
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
    setAiMode(null);
    setStep('upload');
  };

  // ---- splash ----

  if (showSplash) {
    return (
      <div className="splash-screen position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center">
        {!videoFailed ? (
          <video autoPlay muted playsInline preload="auto" className="mw-100 mh-100" src="/spy_logo.mp4" onEnded={() => setShowSplash(false)} onError={() => setVideoFailed(true)} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/spy-logo.png" alt="S.py Printing World" style={{ maxWidth: '70%', maxHeight: '70%' }} />
        )}
        <style jsx global>{splashStyles}</style>
      </div>
    );
  }

  // ---- status ----

  const heartbeatStale = !printerStatus?.last_heartbeat || Date.now() - new Date(printerStatus.last_heartbeat).getTime() > HEARTBEAT_STALE_MS;
  const printerOffline = !statusLoading && !statusError && (heartbeatStale || !printerStatus?.pi_internet_online);
  const printerDisconnected = !statusLoading && !statusError && !heartbeatStale && !!printerStatus && !printerStatus.pi_printer_connected;
  const lowPaper = !!printerStatus && printerStatus.paper_remaining < LOW_PAPER_THRESHOLD;
  const printerDisabled = !!printerStatus && !printerStatus.is_enabled;
  const canUpload = !statusLoading && !statusError && !printerOffline && !printerDisconnected && !lowPaper && !printerDisabled;

  // ---- file row pieces ----

  const renderCopies = (item: UploadedFile) => (
    <div className="mt-2 d-flex align-items-center gap-2 flex-wrap">
      <span className="small text-secondary">Copies:</span>
      <button onClick={() => updateCopies(item.id, item.copies - 1)} disabled={item.copies <= 1} className="btn btn-sm btn-outline-secondary rounded-circle p-0" style={{ width: 26, height: 26, lineHeight: 1 }}>
        <i className="bi bi-dash"></i>
      </button>
      <input
        type="number"
        min={1}
        max={MAX_COPIES}
        value={item.copies}
        onChange={(e) => updateCopies(item.id, Number(e.target.value))}
        className="form-control form-control-sm bg-dark text-light border-secondary text-center"
        style={{ width: 50 }}
      />
      <button onClick={() => updateCopies(item.id, item.copies + 1)} disabled={item.copies >= MAX_COPIES} className="btn btn-sm btn-outline-secondary rounded-circle p-0" style={{ width: 26, height: 26, lineHeight: 1 }}>
        <i className="bi bi-plus"></i>
      </button>
      {item.copies > 1 && (
        <span className="small text-info">
          = {item.pageCount * item.copies} {item.category === 'BLANK' ? 'sheets' : 'pages'} total, ₹{priceItem(item).toFixed(2)}
        </span>
      )}
    </div>
  );

  const renderEco = (item: UploadedFile) =>
    aiReady && item.category !== 'BLANK' ? (
      <div className="form-check form-switch mt-2">
        <input className="form-check-input" type="checkbox" id={`eco-${item.id}`} checked={item.ecoInk} onChange={(e) => patchFile(item.id, { ecoInk: e.target.checked })} />
        <label className="form-check-label small text-secondary" htmlFor={`eco-${item.id}`}>
          <i className="bi bi-leaf-fill text-success me-1"></i>
          <strong className="text-light">AI Eco-Ink</strong> <span className="badge bg-success">FREE</span> — whitens dark slides and scan shadows to save toner
        </label>
      </div>
    ) : null;

  const renderDuplex = (item: UploadedFile) =>
    item.category === 'IMAGE' || item.category === 'BLANK' ? null : item.aiMode === 'EXECSUM' ? (
      <p className="small text-info mb-0 mt-2">
        <i className="bi bi-layers-half me-1"></i>Double-sided printing is included automatically.
      </p>
    ) : item.aiMode === 'CHEATSHEET' ? null : (
      <div className="form-check form-switch mt-2">
        <input className="form-check-input" type="checkbox" id={`duplex-${item.id}`} checked={item.duplex} onChange={(e) => patchFile(item.id, { duplex: e.target.checked })} />
        <label className="form-check-label small text-secondary" htmlFor={`duplex-${item.id}`}>
          Print double-sided (₹{priceItem(item, true).toFixed(2)} instead of ₹{priceItem(item, false).toFixed(2)})
        </label>
      </div>
    );

  const renderGreen = (item: UploadedFile) => {
    if (!aiReady || item.aiMode || item.category === 'IMAGE' || item.category === 'BLANK') return null;
    return (
      <div className="mt-2">
        <div className="form-check form-switch">
          <input
            className="form-check-input"
            type="checkbox"
            id={`green-${item.id}`}
            checked={item.greenAi}
            disabled={item.aiState === 'processing' || !!item.greenSkipped || item.totalPages < 2}
            onChange={(e) => toggleGreen(item.id, e.target.checked)}
          />
          <label className="form-check-label small text-secondary" htmlFor={`green-${item.id}`}>
            <i className="bi bi-recycle text-success me-1"></i>
            <strong className="text-light">Green AI</strong> — crop margins &amp; reflow into fewer pages <span className="badge bg-warning text-dark">+₹{cfg.greenAiFee.toFixed(0)}</span>
          </label>
        </div>
        {item.greenAi && item.greenReady && item.greenPages != null && (
          <p className="small text-success mb-0 mt-1">
            <i className="bi bi-check-circle-fill me-1"></i>
            {item.aiNote || `${item.totalPages} → ${item.greenPages} pages`}. You're billed for {item.greenPages} page{item.greenPages === 1 ? '' : 's'} + ₹{cfg.greenAiFee.toFixed(0)} for Green AI.
          </p>
        )}
        {item.greenSkipped && (
          <p className="small text-secondary mb-0 mt-1">
            <i className="bi bi-info-circle me-1"></i>
            {item.aiNote || 'Green AI could not shorten this document.'} No extra fee.
          </p>
        )}
        {item.aiState === 'failed' && !item.aiMode && (
          <p className="small text-danger mb-0 mt-1">
            <i className="bi bi-exclamation-triangle-fill me-1"></i>
            {item.aiError} You can print normally without Green AI.
          </p>
        )}
      </div>
    );
  };

  const renderRange = (item: UploadedFile) => {
    if (item.counting || item.countFailed || item.estimated || item.category === 'IMAGE' || item.category === 'BLANK' || item.totalPages <= 1) return null;
    const lockedByGreen = item.greenAi;
    if (item.aiState === 'processing') return null;
    return (
      <div className="mt-2">
        <input
          type="text"
          disabled={lockedByGreen}
          placeholder={
            item.aiMode
              ? `Pages to summarise (e.g. 1-5, 8, 12-15) — leave blank for all ${item.totalPages}`
              : lockedByGreen
              ? 'Page selection is off while Green AI is on'
              : `Print specific pages (e.g. 1-5, 8, 12-15) — leave blank for all ${item.totalPages}`
          }
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
    );
  };

  const renderSummaryControls = (item: UploadedFile) => {
    if (!item.aiMode || item.counting) return null;
    const meta = AI_META[item.aiMode];
    const price = item.aiMode === 'CHEATSHEET' ? cfg.cheatsheetPrice : cfg.execsumPrice;
    const slow = item.aiState === 'processing' && item.aiStartedAt && Date.now() - item.aiStartedAt > AI_SLOW_MS;
    return (
      <div className="mt-2">
        {item.aiState !== 'processing' && (
          <button
            onClick={() => startAi(item.id, 'SUMMARY')}
            disabled={!slmReady || !!item.pageRangeError || item.totalPages === 0}
            className="btn btn-sm w-100 fw-bold ai-generate"
            style={{ background: meta.gradient }}
          >
            <i className="bi bi-stars me-2"></i>
            {item.aiState === 'ready' ? `Regenerate ${meta.verb}` : `Generate ${meta.verb}`} — ₹{price.toFixed(0)}
          </button>
        )}
        {item.aiState === 'ready' && (
          <div className="small mt-2 text-success">
            <i className="bi bi-check-circle-fill me-1"></i>
            Ready: {item.pageCount}-page {meta.verb}. {item.aiScore != null && <>Grounding check <strong>{item.aiScore.toFixed(0)}%</strong> of the AI-written text's key terms appear in your document.</>}
          </div>
        )}
        {item.aiState === 'failed' && (
          <p className="small text-danger mb-0 mt-2">
            <i className="bi bi-exclamation-triangle-fill me-1"></i>
            {item.aiError} You haven't been charged.
          </p>
        )}
        {slow && (
          <p className="small text-warning mb-0 mt-2">
            <i className="bi bi-hourglass-split me-1"></i>Taking longer than usual — the printer may be busy with another job.
          </p>
        )}
      </div>
    );
  };

  const renderFileRow = (item: UploadedFile) => {
    const busy = item.aiState === 'processing';
    const label = item.aiMode ? AI_META[item.aiMode].verb : item.greenAi ? 'Green AI' : '';
    return (
      <div key={item.id} className="file-row p-2 rounded mb-2">
        <div className="d-flex justify-content-between align-items-center">
          <div className="d-flex align-items-center gap-2 text-truncate me-2">
            <span className="badge bg-info text-dark">{item.aiMode ? 'AI' : item.category}</span>
            <span className="small text-truncate">{item.category === 'BLANK' ? `Blank pages x${item.pageCount}` : item.file?.name}</span>
          </div>
          <div className="d-flex align-items-center gap-2">
            {item.counting ? (
              <span className="small text-info d-flex align-items-center gap-1">
                <span className="spinner-border spinner-border-sm" role="status" />
                Checking file...
              </span>
            ) : item.estimated ? (
              <div className="d-flex align-items-center gap-1">
                <input type="number" min={1} value={item.pageCount} onChange={(e) => updatePageCount(item.id, Number(e.target.value))} className="form-control form-control-sm bg-dark text-light border-secondary" style={{ width: 60 }} />
                <span className="small text-secondary">pg (est.)</span>
              </div>
            ) : (
              <span className="small text-secondary">
                {item.category === 'BLANK'
                  ? `${item.pageCount} sheet${item.pageCount === 1 ? '' : 's'}`
                  : item.aiMode
                  ? item.aiState === 'ready'
                    ? `${item.pageCount} pg summary`
                    : `${item.totalPages} pg source`
                  : item.greenAi && item.greenReady
                  ? `${item.pageCount} pg (was ${item.totalPages})`
                  : item.pageRange
                  ? `${item.pageCount} of ${item.totalPages} pg`
                  : `${item.pageCount} pg`}
              </span>
            )}
            <button onClick={() => removeFile(item.id)} disabled={item.counting || busy} className="btn btn-sm btn-outline-danger border-0">
              <i className="bi bi-trash-fill"></i>
            </button>
          </div>
        </div>

        {busy && <PiMonitor telemetry={item.aiTelemetry} startedAt={item.aiStartedAt ?? 0} title={`preparing ${label}`} />}

        {!item.counting && !busy && (
          <>
            {renderRange(item)}
            {item.aiMode ? null : renderCopies(item)}
            {item.aiMode && item.totalPages > 0 && renderCopies(item)}
            {renderDuplex(item)}
            {renderEco(item)}
            {renderGreen(item)}
          </>
        )}
        {renderSummaryControls(item)}

        {item.rejected && (
          <p className="small text-danger mb-0 mt-1">
            <i className="bi bi-shield-exclamation me-1"></i>{item.rejected} Please remove this file to continue.
          </p>
        )}
        {item.countFailed && (
          <p className="small text-warning mb-0 mt-1">
            <i className="bi bi-info-circle me-1"></i>The printer couldn't read this file to count its pages — please check and correct the number above before paying.
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
            <i className="bi bi-hourglass-split me-1"></i>Taking longer than usual — the printer may be busy or briefly offline. Still waiting...
          </p>
        )}
      </div>
    );
  };

  // ---- screens ----

  const header = (
    <header className="w-100 text-center pb-3 mb-4" style={{ maxWidth: 720 }}>
      <div className="d-flex align-items-center justify-content-start">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/spy-logo.png" alt="S.py Printing World" style={{ height: 64, width: 'auto' }} />
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
  );

  const homeScreen = (
    <>
      <p className="text-center text-secondary small mb-0">Choose what you'd like to print</p>
      <div className="row g-3">
        {(Object.keys(CATEGORY_META) as Category[]).map((cat) => {
          const meta = CATEGORY_META[cat];
          return (
            <div className="col-6 col-md-4 col-lg-3" key={cat}>
              <button disabled={!canUpload} onClick={() => openPicker(cat)} className="category-card w-100 p-3 d-flex flex-column align-items-center gap-2 border-0" style={{ background: meta.gradient }}>
                <i className={`bi ${meta.icon} fs-2`}></i>
                <span className="small fw-semibold">{cat === 'BLANK' ? meta.label : `Upload ${meta.label}`}</span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="d-flex align-items-center gap-2 mt-2">
        <i className="bi bi-stars text-info"></i>
        <span className="small text-secondary fw-semibold text-uppercase">AI tools</span>
        <span className="badge bg-secondary">on-device</span>
      </div>
      <div className="row g-3">
        {(Object.keys(AI_META) as AiMode[]).map((mode) => {
          const meta = AI_META[mode];
          const price = mode === 'CHEATSHEET' ? cfg.cheatsheetPrice : cfg.execsumPrice;
          const enabled = canUpload && slmReady;
          return (
            <div className="col-12 col-md-6" key={mode}>
              <button disabled={!enabled} onClick={() => setAiMode(mode)} className="category-card w-100 p-3 d-flex align-items-center gap-3 border-0 text-start" style={{ background: meta.gradient }}>
                <i className="bi bi-stars fs-1"></i>
                <span>
                  <span className="d-block fw-bold">{meta.label}</span>
                  <span className="d-block small">{meta.blurb}</span>
                  <span className="d-block small fw-semibold">{slmReady ? `Flat ₹${price.toFixed(0)} per copy` : 'Not available on this printer yet'}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {aiReady && (
        <p className="small text-center text-success mb-0">
          <i className="bi bi-leaf-fill me-1"></i>
          <strong>AI Eco-Ink is free on every print</strong> — it whitens dark slides and shadowed scans to save toner.
        </p>
      )}
    </>
  );

  const sourceChooser = aiMode && (
    <div className="card kiosk-card">
      <div className="card-header d-flex justify-content-between align-items-center border-secondary">
        <button onClick={() => setAiMode(null)} className="btn btn-link text-secondary text-decoration-none p-0 d-flex align-items-center gap-1">
          <i className="bi bi-arrow-left"></i>
          <span className="small">Back</span>
        </button>
        <h6 className="mb-0 fw-bold">
          <i className="bi bi-stars text-info me-2"></i>
          {AI_META[aiMode].label} — {AI_META[aiMode].blurb}
        </h6>
      </div>
      <div className="card-body d-flex flex-column gap-3">
        <AiTrustNote />
        <p className="text-center text-secondary small mb-0">What kind of document do you want summarised?</p>
        <div className="row g-3">
          {SOURCE_TYPES.map((cat) => (
            <div className="col-4" key={cat}>
              <button onClick={() => openPicker(cat)} className="category-card w-100 p-3 d-flex flex-column align-items-center gap-2 border-0" style={{ background: CATEGORY_META[cat].gradient }}>
                <i className={`bi ${CATEGORY_META[cat].icon} fs-2`}></i>
                <span className="small fw-semibold">{CATEGORY_META[cat].label}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const uploadCard = selectedCategory && (
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
          <i className={`bi ${aiMode ? 'bi-stars' : CATEGORY_META[selectedCategory].icon} text-info`}></i>
          <h6 className="mb-0 fw-bold">
            {aiMode
              ? `${AI_META[aiMode].label} · ${CATEGORY_META[selectedCategory].label}`
              : selectedCategory === 'BLANK'
              ? 'Blank Pages'
              : files.length > 0
              ? `Selected Files (${files.length})`
              : `Add your ${CATEGORY_META[selectedCategory].label} files`}
          </h6>
        </div>
      </div>

      {selectedCategory === 'BLANK' && (
        <div className="card-body">
          <BlankPagesPicker onAdd={addBlankPages} unitPrice={cfg.blankCostPerPage} />
        </div>
      )}

      {aiMode && (
        <div className="px-3 pt-3">
          <AiTrustNote />
        </div>
      )}

      {!aiMode && selectedCategory !== 'IMAGE' && selectedCategory !== 'BLANK' && files.length > 0 && (
        <div className="px-3 pt-3">
          <div className="alert alert-info d-flex align-items-center gap-2 mb-0" role="alert">
            <i className="bi bi-recycle fs-5"></i>
            <div className="small">
              <strong>Save with double-sided printing!</strong> ₹{cfg.duplexCostPerSheet.toFixed(2)} for 2 pages instead of ₹{(cfg.costPerPage * 2).toFixed(2)} — look for the toggle on each file below.
            </div>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="card-body p-2" style={{ maxHeight: 520, overflowY: 'auto' }}>
          {files.map(renderFileRow)}
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
              Max {(MAX_FILE_SIZE_BYTES[selectedCategory] / 1048576).toFixed(0)} MB per file, 350 MB total per order
            </p>
          </>
        )}

        {files.length > 0 && (
          <>
            {files.some((f) => f.category !== 'BLANK') && <div className="text-end small text-secondary">Size: {getTotalSizeMB()} / 350 MB</div>}
            <button
              onClick={handleProceedToCheckout}
              disabled={!canUpload || isUploading || anyFileStillCounting || anyRejected || anyPageRangeError || anyAiBusy || summaryNotReady}
              className="btn btn-print fw-bold w-100 py-2"
            >
              {isUploading ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  Uploading files...
                </>
              ) : anyAiBusy ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  AI is preparing your document...
                </>
              ) : anyRejected ? (
                <>
                  <i className="bi bi-shield-exclamation me-2"></i> Remove the rejected file to continue
                </>
              ) : anyFileStillCounting ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  Checking file...
                </>
              ) : summaryNotReady ? (
                <>
                  <i className="bi bi-stars me-2"></i> Generate your summary to continue
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
  );

  const ecoFiles = files.filter((f) => f.ecoInk && f.category !== 'BLANK').length;
  const aiTotal = sumAmount(files.filter(isAi));
  const blankTotal = sumAmount(files.filter((f) => f.category === 'BLANK'));
  const printedTotal = sumAmount(files.filter((f) => !isAi(f) && f.category !== 'BLANK')) - greenFees;
  const blankSheets = files.filter((f) => f.category === 'BLANK').reduce((a, f) => a + f.pageCount * f.copies, 0);
  const printedPages = files.filter((f) => !isAi(f) && f.category !== 'BLANK').reduce((a, f) => a + f.pageCount * f.copies, 0);

  const Line = ({ label, value, last }: { label: string; value: string; last?: boolean }) => (
    <div className={`d-flex justify-content-between ${last ? 'pb-2 mb-3' : 'pb-2 mb-2'} border-bottom border-secondary`}>
      <span className="text-secondary">{label}</span>
      <span className="fw-semibold">{value}</span>
    </div>
  );

  const checkoutScreen = (
    <div className="d-flex flex-column gap-3">
      <button onClick={() => setStep('upload')} disabled={isProcessingPayment} className="btn btn-link text-secondary text-decoration-none p-0 text-start">
        <i className="bi bi-arrow-left me-1"></i> Back to File Upload
      </button>

      <div className="card kiosk-card">
        <div className="card-body">
          <h5 className="card-title text-info fw-bold mb-3">Final Print Breakdown</h5>
          <Line label="Total Files Selected:" value={String(files.length)} />
          {printedPages > 0 && <Line label={`Printed Pages (${printedPages}):`} value={`₹${printedTotal.toFixed(2)}`} />}
          {greenFees > 0 && <Line label="Green AI (crop & reflow):" value={`₹${greenFees.toFixed(2)}`} />}
          {aiTotal > 0 && <Line label={`AI summaries (${files.filter(isAi).length}):`} value={`₹${aiTotal.toFixed(2)}`} />}
          {blankSheets > 0 && <Line label={`Blank Sheets (${blankSheets} × ₹${cfg.blankCostPerPage.toFixed(2)}):`} value={`₹${blankTotal.toFixed(2)}`} />}
          {ecoFiles > 0 && <Line label={`AI Eco-Ink on ${ecoFiles} file${ecoFiles === 1 ? '' : 's'}:`} value="FREE" last />}

          <div className="d-flex justify-content-between align-items-center mb-3">
            <span className="h6 mb-0">Total Payable Amount:</span>
            <span className="h4 text-success fw-bold mb-0">₹{getTotalCost().toFixed(2)}</span>
          </div>

          <button onClick={handleRazorpayPayment} disabled={isProcessingPayment} className="btn btn-success fw-bold w-100 py-2">
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
          <h6 className="card-subtitle mb-2 text-secondary text-uppercase small">Live Printer Queue ({activeQueue.length} ahead of you)</h6>
          {activeQueue.length === 0 ? (
            <p className="small text-muted fst-italic mb-0">No one in line. Your job will print immediately after payment!</p>
          ) : (
            <div className="d-flex flex-column gap-2" style={{ maxHeight: 150, overflowY: 'auto' }}>
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
  );

  const successScreen = (
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
  );

  return (
    <div className="kiosk-bg min-vh-100 text-light d-flex flex-column align-items-center p-3 p-md-4">
      {header}

      {errorMsg && (
        <div className="alert alert-danger w-100" style={{ maxWidth: 720 }} role="alert">
          {errorMsg}
        </div>
      )}

      <main className="w-100" style={{ maxWidth: 720 }}>
        {step === 'upload' && (
          <div className="d-flex flex-column gap-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="d-none"
              accept={selectedCategory ? CATEGORY_META[selectedCategory].accept : undefined}
              onChange={handleFileChange}
            />
            {!selectedCategory && !aiMode && homeScreen}
            {!selectedCategory && aiMode && sourceChooser}
            {selectedCategory && uploadCard}
          </div>
        )}
        {step === 'checkout' && checkoutScreen}
        {step === 'success' && successScreen}
      </main>
      <style jsx global>{dashboardStyles}</style>
    </div>
  );
}

const splashStyles = `
  .splash-screen { background: radial-gradient(circle at 50% 40%, #101820 0%, #000000 80%); }
`;

const dashboardStyles = `
  .kiosk-bg { background: radial-gradient(circle at 50% 0%, #172029 0%, #0a0e12 60%); }
  .status-pill { display:inline-flex; align-items:center; padding:.5rem .9rem; border-radius:999px; font-size:.85rem; font-weight:600; border:1px solid transparent; }
  .status-pill-green { background:rgba(25,135,84,.15); color:#4ade80; border-color:rgba(25,135,84,.4); }
  .status-pill-red { background:rgba(220,53,69,.15); color:#f87171; border-color:rgba(220,53,69,.4); }
  .status-pill-amber { background:rgba(255,193,7,.15); color:#fbbf24; border-color:rgba(255,193,7,.4); }
  .status-pill-neutral { background:rgba(148,163,184,.15); color:#cbd5e1; border-color:rgba(148,163,184,.35); }
  .category-card { border-radius:16px; color:#fff; box-shadow:0 8px 20px rgba(0,0,0,.35); transition:transform .15s ease, box-shadow .15s ease; }
  .category-card:hover:not(:disabled) { transform:translateY(-4px); box-shadow:0 12px 26px rgba(0,0,0,.45); }
  .category-card:disabled { opacity:.4; cursor:not-allowed; }
  .kiosk-card { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:14px; backdrop-filter:blur(6px); }
  .file-row { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06); }
  .btn-print { background:linear-gradient(135deg,#36d1dc,#5b86e5); border:none; color:#041019; }
  .btn-print:hover { filter:brightness(1.08); color:#041019; }
  .ai-generate { border:none; color:#fff; }
  .ai-generate:disabled { opacity:.5; }
  .ai-trust { background:rgba(54,209,220,.08); border:1px solid rgba(54,209,220,.25); border-radius:10px; padding:.6rem .8rem; color:#cfe9ee; display:flex; }
`;