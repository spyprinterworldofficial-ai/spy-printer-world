'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

const MAX_TOTAL_SIZE_BYTES = 350 * 1024 * 1024; // 350 MB
const COST_PER_PAGE = 4; // ₹4 per page

interface PrinterStatus {
  name: string;
  is_enabled: boolean;
  paper_remaining: number;
  pi_internet_online: boolean;
  pi_printer_connected: boolean;
}

interface UploadedFile {
  id: string;
  file: File;
  category: 'PDF' | 'IMAGE' | 'PPT' | 'DOC';
  pageCount: number;
}

export default function KioskPage() {
  const { printer_id } = useParams();

  const [showSplash, setShowSplash] = useState(true);
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<'PDF' | 'IMAGE' | 'PPT' | 'DOC'>('PDF');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [step, setStep] = useState<'upload' | 'checkout' | 'success'>('upload');

  const [activeQueue, setActiveQueue] = useState<any[]>([]);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 4500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!printer_id) return;

    const fetchStatus = async () => {
      const { data } = await supabase
        .from('printers')
        .select('*')
        .eq('id', printer_id)
        .single();
      if (data) setPrinterStatus(data);
    };

    const fetchQueue = async () => {
      const { data } = await supabase
        .from('print_jobs')
        .select('file_name, pages_count, created_at')
        .eq('printer_id', printer_id)
        .in('status', ['PAID', 'PRINTING']);
      if (data) setActiveQueue(data);
    };

    fetchStatus();
    fetchQueue();

    const channel = supabase
      .channel('kiosk-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printers', filter: `id=eq.${printer_id}` }, (payload) => {
        setPrinterStatus(payload.new as PrinterStatus);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs', filter: `printer_id=eq.${printer_id}` }, () => {
        fetchQueue();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [printer_id]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const newFiles = Array.from(e.target.files);
    const currentTotalSize = files.reduce((acc, f) => acc + f.file.size, 0);
    const newFilesTotalSize = newFiles.reduce((acc, f) => acc + f.size, 0);

    if (currentTotalSize + newFilesTotalSize > MAX_TOTAL_SIZE_BYTES) {
      alert('Total size limit exceeded! You can only upload up to 350 MB in total.');
      return;
    }

    const processedFiles: UploadedFile[] = newFiles.map((file) => ({
      id: Math.random().toString(36).substring(7),
      file,
      category: selectedCategory,
      pageCount: selectedCategory === 'IMAGE' ? 1 : Math.floor(Math.random() * 5) + 1,
    }));

    setFiles((prev) => [...prev, ...processedFiles]);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const getTotalPages = () => files.reduce((acc, f) => acc + f.pageCount, 0);
  const getTotalCost = () => getTotalPages() * COST_PER_PAGE;
  const getTotalSizeMB = () => (files.reduce((acc, f) => acc + f.file.size, 0) / (1024 * 1024)).toFixed(2);

  const handleRazorpayPayment = async () => {
    setIsProcessingPayment(true);

    try {
      const res = await fetch('/api/create-razorpay-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: getTotalCost(),
          printer_id,
          file_count: files.length,
          total_pages: getTotalPages(),
        }),
      });

      const orderData = await res.json();

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: 'INR',
        name: 'S.py - Printer World',
        description: `Print Payment (${getTotalPages()} Pages)`,
        order_id: orderData.order_id,
        handler: async function () {
          setStep('success');
          setIsProcessingPayment(false);
        },
        modal: {
          ondismiss: function () {
            setIsProcessingPayment(false);
          },
        },
        theme: { color: '#0dcaf0' },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.open();
    } catch (err) {
      console.error(err);
      alert('Failed to initialize payment. Please try again.');
      setIsProcessingPayment(false);
    }
  };

  // 1. SPLASH SCREEN
  if (showSplash) {
    return (
      <div className="position-fixed top-0 start-0 w-100 h-100 bg-black d-flex flex-column align-items-center justify-content-center z-3 text-white">
        <video autoPlay muted playsInline className="mw-100 mh-100" src="/spy-logo.mp4" />
        <div className="text-center mt-3">
          <h1 className="fw-bold text-info tracking-wide m-0">S.py</h1>
          <p className="text-secondary small tracking-widest text-uppercase mt-1">Printing World</p>
        </div>
      </div>
    );
  }

  // 2. MAIN DASHBOARD
  return (
    <div className="min-vh-100 bg-dark text-light d-flex flex-column align-items-center p-3 p-md-4">
      {/* Top Header */}
      <header className="w-100 max-width-700 text-center border-bottom border-secondary pb-3 mb-4" style={{ maxWidth: '700px' }}>
        <div className="d-flex align-items-center justify-content-center gap-2">
          <div className="bg-info text-dark px-3 py-1 rounded fw-bold fs-4">S.py</div>
          <div className="text-start">
            <h1 className="h4 fw-bold text-info m-0">S.py - Printing World</h1>
            <p className="small text-secondary m-0">Autonomous Print Kiosk</p>
          </div>
        </div>

        {/* Live Status Indicators */}
        <div className="mt-3 d-flex flex-wrap justify-content-center gap-2">
          {!printerStatus?.pi_internet_online ? (
            <span className="badge bg-danger text-wrap p-2 border border-danger">
              <i className="bi bi-wifi-off me-1"></i> No internet connectivity of printer with internet, please wait to establish the internet
            </span>
          ) : printerStatus.paper_remaining < 10 ? (
            <span className="badge bg-warning text-dark text-wrap p-2 border border-warning">
              <i className="bi bi-exclamation-triangle-fill me-1"></i> Paper count low: Please wait until refill
            </span>
          ) : (
            <span className="badge bg-success text-wrap p-2 border border-success">
              <i className="bi bi-check-circle-fill me-1"></i> Printer Ready ({printerStatus.paper_remaining} pages remaining)
            </span>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="w-100" style={{ maxWidth: '700px' }}>
        {step === 'upload' && (
          <div className="d-flex flex-column gap-4">
            {/* 4 Category Cards */}
            <div className="row g-2">
              {[
                { id: 'PDF', label: 'Upload PDF', icon: 'bi-file-earmark-pdf-fill', color: 'btn-outline-danger' },
                { id: 'IMAGE', label: 'Upload Image', icon: 'bi-file-earmark-image-fill', color: 'btn-outline-primary' },
                { id: 'PPT', label: 'Upload PPT', icon: 'bi-file-earmark-slides-fill', color: 'btn-outline-warning' },
                { id: 'DOC', label: 'Upload Doc', icon: 'bi-file-earmark-word-fill', color: 'btn-outline-info' },
              ].map((cat) => (
                <div className="col-6 col-md-3" key={cat.id}>
                  <button
                    onClick={() => {
                      setSelectedCategory(cat.id as any);
                      fileInputRef.current?.click();
                    }}
                    className={`btn ${selectedCategory === cat.id ? 'btn-info text-dark' : cat.color} w-100 p-3 d-flex flex-column align-items-center gap-2`}
                  >
                    <i className={`bi ${cat.icon} fs-3`}></i>
                    <span className="small fw-semibold">{cat.label}</span>
                  </button>
                </div>
              ))}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="d-none"
              accept={
                selectedCategory === 'PDF' ? '.pdf' :
                selectedCategory === 'IMAGE' ? 'image/*' :
                selectedCategory === 'PPT' ? '.ppt,.pptx' : '.doc,.docx'
              }
              onChange={handleFileChange}
            />

            {/* Dropzone Trigger */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border border-2 border-secondary border-dashed rounded-3 p-4 text-center cursor-pointer bg-body-tertiary"
              style={{ cursor: 'pointer' }}
            >
              <i className="bi bi-cloud-upload-fill text-info fs-1"></i>
              <p className="mb-1 fw-semibold">
                Click to select multiple <span className="text-info">{selectedCategory}</span> files
              </p>
              <p className="small text-secondary mb-0">Total batch upload limit: 350 MB</p>
            </div>

            {/* Files List */}
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
                        <span className="small text-secondary">{item.pageCount} pg</span>
                        <button onClick={() => removeFile(item.id)} className="btn btn-sm btn-outline-danger border-0">
                          <i className="bi bi-trash-fill"></i>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="card-footer border-secondary">
                  <button
                    onClick={() => setStep('checkout')}
                    disabled={!printerStatus?.pi_internet_online || printerStatus?.paper_remaining < 1}
                    className="btn btn-info text-dark fw-bold w-100 py-2"
                  >
                    <i className="bi bi-printer-fill me-2"></i> Proceed to Print Preview
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 3. CHECKOUT */}
        {step === 'checkout' && (
          <div className="d-flex flex-column gap-3">
            <button onClick={() => setStep('upload')} className="btn btn-link text-secondary text-decoration-none p-0 text-start">
              <i className="bi bi-arrow-left me-1"></i> Back to File Upload
            </button>

            <div className="card bg-body-tertiary border-secondary">
              <div className="card-body">
                <h5 className="card-title text-info fw-bold mb-3">Final Print Breakdown</h5>
                <div className="d-flex justify-between border-bottom border-secondary pb-2 mb-2">
                  <span className="text-secondary">Total Files Selected:</span>
                  <span className="fw-semibold">{files.length}</span>
                </div>
                <div className="d-flex justify-between border-bottom border-secondary pb-2 mb-2">
                  <span className="text-secondary">Total Calculated Pages:</span>
                  <span className="fw-semibold">{getTotalPages()} Pages</span>
                </div>
                <div className="d-flex justify-between border-bottom border-secondary pb-2 mb-3">
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
                  <i className="bi bi-credit-card-fill me-2"></i>
                  {isProcessingPayment ? 'Connecting Razorpay...' : `Pay ₹${getTotalCost()}.00 Now`}
                </button>
              </div>
            </div>

            {/* Queue Section */}
            <div className="card bg-dark border-secondary">
              <div className="card-body">
                <h6 className="card-subtitle mb-2 text-secondary text-uppercase small">
                  Live Printer Queue ({activeQueue.length} ahead of you)
                </h6>
                {activeQueue.length === 0 ? (
                  <p className="small text-muted italic mb-0">No one in line. Your job will print immediately after payment!</p>
                ) : (
                  <div className="d-flex flex-column gap-2" style={{ maxHeight: '150px', overflowY: 'auto' }}>
                    {activeQueue.map((q, idx) => (
                      <div key={idx} className="d-flex justify-content-between align-items-center small bg-body-tertiary p-2 rounded border border-secondary">
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

        {/* 4. SUCCESS */}
        {step === 'success' && (
          <div className="card bg-body-tertiary border-secondary text-center p-4">
            <div className="card-body">
              <i className="bi bi-check-circle-fill text-success fs-1 mb-3"></i>
              <h3 className="fw-bold">Payment Successful!</h3>
              <p className="text-info mb-4">Your print is getting ready on the printer...</p>
              <button
                onClick={() => {
                  setFiles([]);
                  setStep('upload');
                }}
                className="btn btn-info text-dark fw-bold w-100 py-2"
              >
                <i className="bi bi-arrow-repeat me-2"></i> Continue to Print More
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}