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

const CATEGORY_META: Record<Category, { label: string; icon: string; color: string; accept: string }> = {
  PDF: { label: 'Upload PDF', icon: 'bi-file-earmark-pdf-fill', color: 'btn-outline-danger', accept: '.pdf' },
  IMAGE: { label: 'Upload Image', icon: 'bi-file-earmark-image-fill', color: 'btn-outline-primary', accept: 'image/*' },
  PPT: { label: 'Upload PPT', icon: 'bi-file-earmark-slides-fill', color: 'btn-outline-warning', accept: '.ppt,.pptx' },
  DOC: { label: 'Upload Doc', icon: 'bi-file-earmark-word-fill', color: 'btn-outline-info', accept: '.doc,.docx' },
};

// ---- Page counting -------------------------------------------------------
// PDFs: counted exactly via pdf.js.
// Images: always 1 page.
// PPT / DOC: there is no reliable way to get an exact page/slide count in
// the browser without a full renderer. We estimate from file size and flag
// it as an estimate in the UI. For accurate billing, confirm the real count
// server-side (e.g. a LibreOffice headless conversion step on the Pi or a
// small serverless function) before charging, or reconcile after printing.

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
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category>('PDF');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [step, setStep] = useState<'upload' | 'checkout' | 'success'>('upload');

  const [activeQueue, setActiveQueue] = useState<QueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Splash screen: hide after the video ends, or after a max wait, or if it fails to load.
  useEffect(() => {
    const maxWait = setTimeout(() => setShowSplash(false), 4500);
    return () => clearTimeout(maxWait);
  }, []);

  // Load the Razorpay checkout script once.
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
      const { data, error } = await supabase
        .from('printers')
        .select('*')
        .eq('id', printerId)
        .single();
      if (!error && data) setPrinterStatus(data as PrinterStatus);
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setErrorMsg(null);

    const newFiles = Array.from(e.target.files);
    const currentTotalSize = files.reduce((acc, f) => acc + f.file.size, 0);
    const newFilesTotalSize = newFiles.reduce((acc, f) => acc + f.size, 0);

    if (currentTotalSize + newFilesTotalSize > MAX_TOTAL_SIZE_BYTES) {
      setErrorMsg('Total size limit exceeded — you can upload up to 350 MB in total.');
      e.target.value = '';
      return;
    }

    const processed: UploadedFile[] = [];
    for (const file of newFiles) {
      const { pageCount, estimated } = await resolvePageCount(file, selectedCategory);
      processed.push({
        id: Math.random().toString(36).slice(2),
        file,
        category: selectedCategory,
        pageCount,
        estimated,
      });
    }

    setFiles((prev) => [...prev, ...processed]);
    e.target.value = ''; // allow re-selecting the same file later
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const getTotalPages = () => files.reduce((acc, f) => acc + f.pageCount, 0);
  const getTotalCost = () => getTotalPages() * COST_PER_PAGE;
  const getTotalSizeMB = () => (files.reduce((acc, f) => acc + f.file.size, 0) / (1024 * 1024)).toFixed(2);

  // Upload every selected file to Supabase Storage and create a PENDING
  // print_jobs row for each. Runs when the user moves to the checkout step.
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
            setErrorMsg('Payment went through but verification failed. Please contact support with your payment ID: ' + response.razorpay_payment_id);
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
    setStep('upload');
  };

  // 1. SPLASH SCREEN
  if (showSplash) {
    return (
      <div className="position-fixed top-0 start-0 w-100 h-100 bg-black d-flex flex-column align-items-center justify-content-center z-3 text-white">
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
          <div className="bg-info text-dark px-4 py-3 rounded fw-bold fs-1">S.py</div>
        )}
        <div className="text-center mt-3">
          <h1 className="fw-bold text-info m-0" style={{ letterSpacing: '2px' }}>S.py</h1>
          <p className="text-secondary small text-uppercase mt-1" style={{ letterSpacing: '3px' }}>Printing World</p>
        </div>
      </div>
    );
  }

  const printerOffline = !printerStatus?.pi_internet_online;
  const lowPaper = !!printerStatus && printerStatus.paper_remaining < LOW_PAPER_THRESHOLD;
  const printerDisabled = !!printerStatus && !printerStatus.is_enabled;
  const canUpload = !printerOffline && !lowPaper && !printerDisabled;

  // 2. MAIN DASHBOARD
  return (
    <div className="min-vh-100 bg-dark text-light d-flex flex-column align-items-center p-3 p-md-4">
      <header className="w-100 text-center border-bottom border-secondary pb-3 mb-4" style={{ maxWidth: '700px' }}>
        <div className="d-flex align-items-center justify-content-center gap-2">
          <div className="bg-info text-dark px-3 py-1 rounded fw-bold fs-4">S.py</div>
          <div className="text-start">
            <h1 className="h4 fw-bold text-info m-0">S.py - Printing World</h1>
            <p className="small text-secondary m-0">Autonomous Print Kiosk</p>
          </div>
        </div>

        <div className="mt-3 d-flex flex-wrap justify-content-center gap-2">
          {printerOffline ? (
            <span className="badge bg-danger text-wrap p-2 border border-danger">
              <i className="bi bi-wifi-off me-1"></i> No internet connectivity of printer, please wait to establish the internet
            </span>
          ) : printerDisabled ? (
            <span className="badge bg-secondary text-wrap p-2 border border-secondary">
              <i className="bi bi-pause-circle-fill me-1"></i> Printer temporarily disabled by admin
            </span>
          ) : lowPaper ? (
            <span className="badge bg-warning text-dark text-wrap p-2 border border-warning">
              <i className="bi bi-exclamation-triangle-fill me-1"></i> Paper count low: Please wait until refill
            </span>
          ) : printerStatus ? (
            <span className="badge bg-success text-wrap p-2 border border-success">
              <i className="bi bi-check-circle-fill me-1"></i> Printer Ready ({printerStatus.paper_remaining} pages remaining)
            </span>
          ) : (
            <span className="badge bg-secondary text-wrap p-2 border border-secondary">
              <i className="bi bi-hourglass-split me-1"></i> Checking printer status...
            </span>
          )}
        </div>
      </header>

      {errorMsg && (
        <div className="alert alert-danger w-100" style={{ maxWidth: '700px' }} role="alert">
          {errorMsg}
        </div>
      )}

      <main className="w-100" style={{ maxWidth: '700px' }}>
        {step === 'upload' && (
          <div className="d-flex flex-column gap-4">
            <div className="row g-2">
              {(Object.keys(CATEGORY_META) as Category[]).map((cat) => {
                const meta = CATEGORY_META[cat];
                return (
                  <div className="col-6 col-md-3" key={cat}>
                    <button
                      disabled={!canUpload}
                      onClick={() => {
                        setSelectedCategory(cat);
                        fileInputRef.current?.click();
                      }}
                      className={`btn ${selectedCategory === cat ? 'btn-info text-dark' : meta.color} w-100 p-3 d-flex flex-column align-items-center gap-2`}
                    >
                      <i className={`bi ${meta.icon} fs-3`}></i>
                      <span className="small fw-semibold">{meta.label}</span>
                    </button>
                  </div>
                );
              })}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="d-none"
              accept={CATEGORY_META[selectedCategory].accept}
              onChange={handleFileChange}
            />

            <div
              onClick={() => canUpload && fileInputRef.current?.click()}
              className="border border-2 border-secondary border-dashed rounded-3 p-4 text-center bg-body-tertiary"
              style={{ cursor: canUpload ? 'pointer' : 'not-allowed', opacity: canUpload ? 1 : 0.5 }}
            >
              <i className="bi bi-cloud-upload-fill text-info fs-1"></i>
              <p className="mb-1 fw-semibold">
                Click to select multiple <span className="text-info">{selectedCategory}</span> files
              </p>
              <p className="small text-secondary mb-0">Total batch upload limit: 350 MB</p>
            </div>

            {files.length > 0 && (
              <div className="card bg-body-tertiary border-secondary">
                <div className="card-header d-flex justify-content-between align-items-center border-secondary">
                  <h6 className="mb-0 fw-bold">Selected Files ({files.length})</h6>
                  <span className="small text-secondary">Size: {getTotalSizeMB()} / 350 MB</span>
                </div>
                <div className="card-body p-2" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                  {files.map((item) => (
                    <div key={item.id} className="d-flex justify-content-between align-items-center bg-dark p-2 rounded mb-2 border border-secondary">
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
                <div className="card-footer border-secondary">
                  <button
                    onClick={handleProceedToCheckout}
                    disabled={!canUpload || isUploading}
                    className="btn btn-info text-dark fw-bold w-100 py-2"
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

            <div className="card bg-body-tertiary border-secondary">
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

            <div className="card bg-dark border-secondary">
              <div className="card-body">
                <h6 className="card-subtitle mb-2 text-secondary text-uppercase small">
                  Live Printer Queue ({activeQueue.length} ahead of you)
                </h6>
                {activeQueue.length === 0 ? (
                  <p className="small text-muted fst-italic mb-0">No one in line. Your job will print immediately after payment!</p>
                ) : (
                  <div className="d-flex flex-column gap-2" style={{ maxHeight: '150px', overflowY: 'auto' }}>
                    {activeQueue.map((q) => (
                      <div key={q.id} className="d-flex justify-content-between align-items-center small bg-body-tertiary p-2 rounded border border-secondary">
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
          <div className="card bg-body-tertiary border-secondary text-center p-4">
            <div className="card-body">
              <i className="bi bi-check-circle-fill text-success fs-1 mb-3"></i>
              <h3 className="fw-bold">Payment Successful!</h3>
              <p className="text-info mb-4">Your print is getting ready on the printer...</p>
              <button onClick={resetToUpload} className="btn btn-info text-dark fw-bold w-100 py-2">
                <i className="bi bi-arrow-repeat me-2"></i> Continue to Print More
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}