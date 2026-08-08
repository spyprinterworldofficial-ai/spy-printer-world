'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

declare global {
  interface Window {
    Razorpay: any;
  }
}

const MAX_TOTAL_SIZE_BYTES = 350 * 1024 * 1024; // 350 MB
const COST_PER_PAGE = 4; // ₹4 per page
const LOW_PAPER_THRESHOLD = 10;

type Category = 'PDF' | 'IMAGE' | 'PPT' | 'DOC';

interface PrinterStatus {
  id: string;
  name: string;
  is_enabled: boolean;
  paper_remaining: number;
  pi_internet_online: boolean;
  pi_printer_connected: boolean;
}

interface UploadedFile {
  id: string;
  file: File;
  category: Category;
  pageCount: number;
  estimated: boolean; // true when page count is a heuristic, not exact
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
};

// ---- Page counting -------------------------------------------------------
// PDFs: counted exactly via pdf.js.
// Images: always 1 page.
// PPT / DOC: no reliable exact count in-browser without a full renderer, so
// we estimate from file size and flag it as an estimate in the UI. For
// exact billing, confirm the real count server-side before charging (e.g. a
// LibreOffice headless conversion step), or reconcile after printing.

async function getPdfPageCount(file: File): Promise<number> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  return pdf.numPages;
}

function estimatePages(file: File, category: Category): number {
  if (category === 'PPT') return Math.max(1, Math.ceil(file.size / (700 * 1024))); // ~700KB/slide
  if (category === 'DOC') return Math.max(1, Math.ceil(file.size / (60 * 1024))); // ~60KB/page
  return 1;
}

async function resolvePageCount(file: File, category: Category): Promise<{ pageCount: number; estimated: boolean }> {
  if (category === 'IMAGE') return { pageCount: 1, estimated: false };
  if (category === 'PDF') {
    try {
      const pageCount = await getPdfPageCount(file);
      return { pageCount, estimated: false };
    } catch (err) {
      console.error('PDF parse failed, falling back to estimate:', err);
      return { pageCount: estimatePages(file, category), estimated: true };
    }
  }
  return { pageCount: estimatePages(file, category), estimated: true };
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const maxWait = setTimeout(() => setShowSplash(false), 4500);
    return () => clearTimeout(maxWait);
  }, []);

  useEffect(() => {
    if (document.getElementById('razorpay-checkout-js')) return;
    const script = document.createElement('script');
    script.id = 'razorpay-checkout-js';
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
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
        () => fetchQueue()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [printerId, fetchQueue]);

  const openPicker = (cat: Category) => {
    setSelectedCategory(cat);
    setTimeout(() => fileInputRef.current?.click(), 0);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !selectedCategory) return;
    setErrorMsg(null);

    const newFiles = Array.from(e.target.files);
    const currentTotalSize = files.reduce((acc, f) => acc + f.file.size, 0);
    const newFilesTotalSize = newFiles.reduce((acc, f) => acc + f.size, 0);

    if (currentTotalSize + newFilesTotalSize > MAX_TOTAL_SIZE_BYTES) {
      setErrorMsg('Total size limit exceeded — you can upload up to 350 MB in total.');
      e.target.value = '';
      return;
    }

    const category = selectedCategory;
    const processed: UploadedFile[] = [];
    for (const file of newFiles) {
      const { pageCount, estimated } = await resolvePageCount(file, category);
      processed.push({
        id: Math.random().toString(36).slice(2),
        file,
        category,
        pageCount,
        estimated,
      });
    }

    setFiles((prev) => [...prev, ...processed]);
    e.target.value = '';
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const getTotalPages = () => files.reduce((acc, f) => acc + f.pageCount, 0);
  const getTotalCost = () => getTotalPages() * COST_PER_PAGE;
  const getTotalSizeMB = () => (files.reduce((acc, f) => acc + f.file.size, 0) / (1024 * 1024)).toFixed(2);

  const handleProceedToCheckout = async () => {
    setErrorMsg(null);
    setIsUploading(true);
    try {
      const jobIds: string[] = [];

      for (const item of files) {
        const path = `${printerId}/${Date.now()}_${item.file.name}`;

        const { error: uploadError } = await supabase.storage
          .from('print-files')
          .upload(path, item.file, { upsert: false });
        if (uploadError) throw uploadError;

        const amount = item.pageCount * COST_PER_PAGE;

        const { data: jobRow, error: insertError } = await supabase
          .from('print_jobs')
          .insert({
            printer_id: printerId,
            file_type: item.category,
            file_name: item.file.name,
            storage_path: path,
            pages_count: item.pageCount,
            amount_paid: amount,
            status: 'PENDING',
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
        body: JSON.stringify({ amount: getTotalCost(), job_ids: pendingJobIds }),
      });
      if (!res.ok) throw new Error('Order creation failed');
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
            src="../../public/spy_logo.mp4"
            onEnded={() => setShowSplash(false)}
            onError={() => setVideoFailed(true)}
          />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src="../../public/Screenshot 2026-08-05 012139.png" alt="S.py Printing World" style={{ maxWidth: '70%', maxHeight: '70%' }} />
        )}
        <style jsx global>{splashStyles}</style>
      </div>
    );
  }

  // While we don't yet know the printer's status, don't claim it's offline —
  // just show a neutral "checking" state and keep buttons disabled only
  // for that reason (with a spinner), not silently forever.
  const printerOffline = !statusLoading && !statusError && !printerStatus?.pi_internet_online;
  const lowPaper = !!printerStatus && printerStatus.paper_remaining < LOW_PAPER_THRESHOLD;
  const printerDisabled = !!printerStatus && !printerStatus.is_enabled;
  const canUpload = !statusLoading && !statusError && !printerOffline && !lowPaper && !printerDisabled;

  // 2. MAIN DASHBOARD
  return (
    <div className="kiosk-bg min-vh-100 text-light d-flex flex-column align-items-center p-3 p-md-4">
      <header className="w-100 text-center pb-3 mb-4" style={{ maxWidth: '720px' }}>
        <div className="d-flex align-items-center justify-content-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="../../public/Screenshot 2026-08-05 012139.png" alt="S.py Printing World" style={{ height: '64px', width: 'auto' }} />
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
                      <div className="col-6 col-md-3" key={cat}>
                        <button
                          disabled={!canUpload}
                          onClick={() => openPicker(cat)}
                          className="category-card w-100 p-3 d-flex flex-column align-items-center gap-2 border-0"
                          style={{ background: meta.gradient }}
                        >
                          <i className={`bi ${meta.icon} fs-2`}></i>
                          <span className="small fw-semibold">Upload {meta.label}</span>
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
                  <div className="d-flex align-items-center gap-2">
                    <i className={`bi ${CATEGORY_META[selectedCategory].icon} text-info`}></i>
                    <h6 className="mb-0 fw-bold">
                      {files.length > 0 ? `Selected Files (${files.length})` : `Add your ${CATEGORY_META[selectedCategory].label} files`}
                    </h6>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedCategory(null);
                      setFiles([]);
                    }}
                    className="btn btn-sm btn-outline-secondary border-0"
                  >
                    <i className="bi bi-arrow-repeat me-1"></i> Change type
                  </button>
                </div>

                {files.length > 0 && (
                  <div className="card-body p-2" style={{ maxHeight: '220px', overflowY: 'auto' }}>
                    {files.map((item) => (
                      <div key={item.id} className="d-flex justify-content-between align-items-center file-row p-2 rounded mb-2">
                        <div className="d-flex align-items-center gap-2 text-truncate me-2">
                          <span className="badge bg-info text-dark">{item.category}</span>
                          <span className="small text-truncate">{item.file.name}</span>
                        </div>
                        <div className="d-flex align-items-center gap-3">
                          <span className="small text-secondary">
                            {item.pageCount} pg{item.estimated ? ' (est.)' : ''}
                          </span>
                          <button onClick={() => removeFile(item.id)} className="btn btn-sm btn-outline-danger border-0">
                            <i className="bi bi-trash-fill"></i>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="card-footer border-secondary d-flex flex-column gap-2">
                  <button onClick={() => openPicker(selectedCategory)} className="btn btn-outline-info fw-semibold w-100 py-2">
                    <i className="bi bi-plus-lg me-2"></i>
                    {files.length > 0 ? `Add more ${CATEGORY_META[selectedCategory].label} files` : `Select ${CATEGORY_META[selectedCategory].label} files`}
                  </button>

                  {files.length > 0 && (
                    <>
                      <div className="text-end small text-secondary">Size: {getTotalSizeMB()} / 350 MB</div>
                      <button
                        onClick={handleProceedToCheckout}
                        disabled={!canUpload || isUploading}
                        className="btn btn-print fw-bold w-100 py-2"
                      >
                        {isUploading ? (
                          <>
                            <span className="spinner-border spinner-border-sm me-2" role="status" />
                            Uploading files...
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
                <div className="d-flex justify-content-between border-bottom border-secondary pb-2 mb-2">
                  <span className="text-secondary">Total Calculated Pages:</span>
                  <span className="fw-semibold">{getTotalPages()} Pages</span>
                </div>
                <div className="d-flex justify-content-between border-bottom border-secondary pb-2 mb-3">
                  <span className="text-secondary">Rate Per Page:</span>
                  <span className="fw-semibold">₹{COST_PER_PAGE}.00 / page</span>
                </div>

                <div className="d-flex justify-content-between align-items-center mb-3">
                  <span className="h6 mb-0">Total Payable Amount:</span>
                  <span className="h4 text-success fw-bold mb-0">₹{getTotalCost()}.00</span>
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
                      Pay ₹{getTotalCost()}.00 Now
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
