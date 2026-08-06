'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FileText, 
  Image as ImageIcon, 
  Presentation, 
  FileCode, 
  UploadCloud, 
  Trash2, 
  AlertTriangle, 
  WifiOff, 
  CheckCircle2, 
  Printer, 
  CreditCard,
  ArrowLeft,
  RotateCcw
} from 'lucide-react';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

const MAX_TOTAL_SIZE_BYTES = 350 * 1024 * 1024; // 350 MB
const COST_PER_PAGE = 3; // ₹3 per page

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
  
  // App States
  const [showSplash, setShowSplash] = useState(true);
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<'PDF' | 'IMAGE' | 'PPT' | 'DOC'>('PDF');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [step, setStep] = useState<'upload' | 'checkout' | 'success'>('upload');
  
  // Queue & Payment States
  const [activeQueue, setActiveQueue] = useState<any[]>([]);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Splash Screen Timer
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 4500); // 4.5 seconds splash screen match
    return () => clearTimeout(timer);
  }, []);

  // Fetch Printer Status & Subscribe to Realtime Updates
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

    // Realtime listener for printer telemetry & queue
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

  // Handle File Selection with 350 MB Check
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const newFiles = Array.from(e.target.files);
    
    // Calculate total size of current files + new files
    const currentTotalSize = files.reduce((acc, f) => acc + f.file.size, 0);
    const newFilesTotalSize = newFiles.reduce((acc, f) => acc + f.size, 0);

    if (currentTotalSize + newFilesTotalSize > MAX_TOTAL_SIZE_BYTES) {
      alert("Total size limit exceeded! You can only upload up to 350 MB in total.");
      return;
    }

    const processedFiles: UploadedFile[] = newFiles.map((file) => ({
      id: Math.random().toString(36).substring(7),
      file,
      category: selectedCategory,
      pageCount: selectedCategory === 'IMAGE' ? 1 : Math.floor(Math.random() * 5) + 1 // Mock page count; real PDF parsing can be attached here
    }));

    setFiles((prev) => [...prev, ...processedFiles]);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const getTotalPages = () => files.reduce((acc, f) => acc + f.pageCount, 0);
  const getTotalCost = () => getTotalPages() * COST_PER_PAGE;
  const getTotalSizeMB = () => (files.reduce((acc, f) => acc + f.file.size, 0) / (1024 * 1024)).toFixed(2);

  // Trigger Razorpay Checkout Window
  const handleRazorpayPayment = async () => {
    setIsProcessingPayment(true);

    try {
      // 1. Call Backend API to create Razorpay Order ID
      const res = await fetch('/api/create-razorpay-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: getTotalCost(),
          printer_id,
          file_count: files.length,
          total_pages: getTotalPages()
        })
      });

      const orderData = await res.json();

      // 2. Open Razorpay Checkout Modal
      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: 'INR',
        name: 'S.py - Printer World',
        description: `Print Payment (${getTotalPages()} Pages)`,
        order_id: orderData.order_id,
        handler: async function (response: any) {
          // Send verification to backend
          setStep('success');
          setIsProcessingPayment(false);
        },
        modal: {
          ondismiss: function () {
            setIsProcessingPayment(false);
          }
        },
        theme: {
          color: '#0284c7'
        }
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.open();
    } catch (err) {
      console.error(err);
      alert('Failed to initialize payment. Please try again.');
      setIsProcessingPayment(false);
    }
  };

  // -------------------------------------------------------------
  // 1. SPLASH SCREEN COMPONENT
  // -------------------------------------------------------------
  if (showSplash) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50 text-white">
        <video
          autoPlay
          muted
          playsInline
          className="w-full max-w-lg object-contain"
          src="../../../../public/spy_logo.mp4"
        />
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1 }}
          className="text-center mt-4"
        >
          <h1 className="text-3xl font-extrabold tracking-wide text-cyan-400">S.py</h1>
          <p className="text-gray-400 text-sm tracking-widest mt-1">PRINTING WORLD</p>
        </motion.div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // 2. MAIN DASHBOARD PAGE
  // -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-4 md:p-6">
      {/* Top Header */}
      <header className="w-full max-w-3xl flex flex-col items-center text-center border-b border-slate-800 pb-4 mb-6">
        <div className="flex items-center space-x-2">
          <div className="bg-cyan-500 text-slate-950 p-2 rounded-lg font-black text-xl">S.py</div>
          <div className="text-left">
            <h1 className="text-xl font-bold tracking-tight text-cyan-400">S.py - Printer World</h1>
            <p className="text-xs text-slate-400">Instant Kiosk Autonomous Print System</p>
          </div>
        </div>

        {/* Live Status Indicators */}
        <div className="mt-4 w-full flex flex-wrap gap-2 justify-center text-xs font-semibold">
          {/* Printer Internet Status */}
          {!printerStatus?.pi_internet_online ? (
            <div className="flex items-center space-x-1.5 bg-red-950/80 text-red-400 border border-red-800 px-3 py-1.5 rounded-full animate-pulse">
              <WifiOff className="w-4 h-4" />
              <span>No internet connectivity of printer with internet, please wait to establish the internet</span>
            </div>
          ) : printerStatus.paper_remaining < 10 ? (
            /* Paper Low Warning */
            <div className="flex items-center space-x-1.5 bg-amber-950/80 text-amber-400 border border-amber-800 px-3 py-1.5 rounded-full">
              <AlertTriangle className="w-4 h-4" />
              <span>Paper count low: Please wait until refill</span>
            </div>
          ) : (
            /* All Systems Ready */
            <div className="flex items-center space-x-1.5 bg-emerald-950/80 text-emerald-400 border border-emerald-800 px-3 py-1.5 rounded-full">
              <CheckCircle2 className="w-4 h-4" />
              <span>Printer Ready ({printerStatus.paper_remaining} pages remaining)</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="w-full max-w-3xl flex-1">
        <AnimatePresence mode="wait">
          {step === 'upload' && (
            <motion.div
              key="upload-step"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-6"
            >
              {/* Category Cards Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { id: 'PDF', label: 'Upload PDF', icon: FileText, color: 'border-red-500/50 hover:border-red-500' },
                  { id: 'IMAGE', label: 'Upload Image', icon: ImageIcon, color: 'border-blue-500/50 hover:border-blue-500' },
                  { id: 'PPT', label: 'Upload PPT', icon: Presentation, color: 'border-orange-500/50 hover:border-orange-500' },
                  { id: 'DOC', label: 'Upload Doc', icon: FileCode, color: 'border-indigo-500/50 hover:border-indigo-500' },
                ].map((cat) => {
                  const Icon = cat.icon;
                  const isSelected = selectedCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => {
                        setSelectedCategory(cat.id as any);
                        fileInputRef.current?.click();
                      }}
                      className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center text-center space-y-2 bg-slate-900/60 backdrop-blur ${
                        isSelected ? 'border-cyan-400 bg-cyan-950/30' : cat.color
                      }`}
                    >
                      <Icon className={`w-8 h-8 ${isSelected ? 'text-cyan-400' : 'text-slate-300'}`} />
                      <span className="text-xs font-semibold">{cat.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Hidden File Input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept={
                  selectedCategory === 'PDF' ? '.pdf' :
                  selectedCategory === 'IMAGE' ? 'image/*' :
                  selectedCategory === 'PPT' ? '.ppt,.pptx' : '.doc,.docx'
                }
                onChange={handleFileChange}
              />

              {/* File Dropzone Trigger */}
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-700 hover:border-cyan-500 rounded-2xl p-8 text-center cursor-pointer bg-slate-900/30 transition-all flex flex-col items-center space-y-2"
              >
                <UploadCloud className="w-10 h-10 text-cyan-400 animate-bounce" />
                <p className="text-sm font-medium text-slate-200">
                  Click to select multiple <span className="text-cyan-400">{selectedCategory}</span> files
                </p>
                <p className="text-xs text-slate-400">Total batch upload limit: 350 MB</p>
              </div>

              {/* Selected Files List */}
              {files.length > 0 && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                  <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                    <h3 className="text-sm font-bold text-slate-200">Selected Files ({files.length})</h3>
                    <span className="text-xs text-slate-400">Size: {getTotalSizeMB()} / 350 MB</span>
                  </div>

                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {files.map((item) => (
                      <div key={item.id} className="flex justify-between items-center bg-slate-950 p-2.5 rounded-lg border border-slate-800 text-xs">
                        <div className="flex items-center space-x-2 truncate">
                          <span className="bg-cyan-950 text-cyan-400 px-1.5 py-0.5 rounded font-mono font-bold">{item.category}</span>
                          <span className="truncate font-medium text-slate-300">{item.file.name}</span>
                        </div>
                        <div className="flex items-center space-x-3">
                          <span className="text-slate-400">{item.pageCount} page(s)</span>
                          <button onClick={() => removeFile(item.id)} className="text-red-400 hover:text-red-300">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Proceed to Print Preview */}
                  <button
                    onClick={() => setStep('checkout')}
                    disabled={!printerStatus?.pi_internet_online || printerStatus?.paper_remaining < 1}
                    className="w-full py-3 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 font-bold rounded-xl text-slate-950 flex items-center justify-center space-x-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Printer className="w-5 h-5" />
                    <span>Proceed to Print Preview</span>
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {/* -------------------------------------------------------------
              3. PREVIEW & BREAKDOWN PAGE
             ------------------------------------------------------------- */}
          {step === 'checkout' && (
            <motion.div
              key="checkout-step"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <button 
                onClick={() => setStep('upload')}
                className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to File Upload</span>
              </button>

              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                <h2 className="text-lg font-bold text-cyan-400">Final Print Breakdown</h2>

                <div className="space-y-2 border-b border-slate-800 pb-4 text-sm">
                  <div className="flex justify-between text-slate-400">
                    <span>Total Files Selected:</span>
                    <span className="text-slate-200 font-semibold">{files.length}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Total Calculated Pages:</span>
                    <span className="text-slate-200 font-semibold">{getTotalPages()} Pages</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Rate Per Page:</span>
                    <span className="text-slate-200 font-semibold">₹{COST_PER_PAGE}.00 / page</span>
                  </div>
                </div>

                <div className="flex justify-between items-center text-lg font-black text-slate-100">
                  <span>Total Payable Amount:</span>
                  <span className="text-2xl text-emerald-400">₹{getTotalCost()}.00</span>
                </div>

                {/* Razorpay Pay Button */}
                <button
                  onClick={handleRazorpayPayment}
                  disabled={isProcessingPayment}
                  className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl flex items-center justify-center space-x-2 transition-all"
                >
                  <CreditCard className="w-5 h-5" />
                  <span>{isProcessingPayment ? 'Connecting Razorpay...' : `Pay ₹${getTotalCost()}.00 Now`}</span>
                </button>
              </div>

              {/* Live Waiting Queue Section */}
              <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                  Live Printer Queue ({activeQueue.length} ahead of you)
                </h3>
                {activeQueue.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">No one in line. Your job will print immediately after payment!</p>
                ) : (
                  <div className="space-y-2 max-h-36 overflow-y-auto">
                    {activeQueue.map((q, idx) => (
                      <div key={idx} className="flex justify-between items-center text-xs bg-slate-950 p-2 rounded border border-slate-800/50 text-slate-400">
                        <span className="truncate">{q.file_name}</span>
                        <span className="font-semibold text-cyan-400">{q.pages_count} pages</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* -------------------------------------------------------------
              4. SUCCESS & CONTINUE PRINTING PAGE
             ------------------------------------------------------------- */}
          {step === 'success' && (
            <motion.div
              key="success-step"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-6"
            >
              <div className="w-16 h-16 bg-emerald-950 text-emerald-400 border border-emerald-800 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-10 h-10 animate-pulse" />
              </div>

              <div>
                <h2 className="text-2xl font-bold text-slate-100">Payment Successful!</h2>
                <p className="text-cyan-400 text-sm font-medium mt-1">Your print is getting ready on the printer...</p>
              </div>

              <button
                onClick={() => {
                  setFiles([]);
                  setStep('upload');
                }}
                className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl flex items-center justify-center space-x-2 transition-all"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Continue to Print More</span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}