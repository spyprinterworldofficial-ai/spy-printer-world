export type AiMode = 'CHEATSHEET' | 'EXECSUM';

export interface PricingConfig {
  costPerPage: number;
  duplexCostPerSheet: number;
  blankCostPerPage: number;
  greenAiFee: number; // flat, once per document
  cheatsheetPrice: number; // flat, per copy
  execsumPrice: number; // flat, per copy
}

export const FALLBACK_PRICING: PricingConfig = {
  costPerPage: 3,
  duplexCostPerSheet: 4.5,
  blankCostPerPage: 1.5,
  greenAiFee: 2,
  cheatsheetPrice: 4,
  execsumPrice: 8,
};

type PrinterPricingRow = {
  cost_per_page?: number | null;
  duplex_cost_per_sheet?: number | null;
  blank_cost_per_page?: number | null;
  green_ai_fee?: number | null;
  cheatsheet_price?: number | null;
  execsum_price?: number | null;
} | null | undefined;

export function pricingFromPrinter(p: PrinterPricingRow): PricingConfig {
  const pick = (v: number | null | undefined, fallback: number) => (v === null || v === undefined ? fallback : Number(v));
  return {
    costPerPage: pick(p?.cost_per_page, FALLBACK_PRICING.costPerPage),
    duplexCostPerSheet: pick(p?.duplex_cost_per_sheet, FALLBACK_PRICING.duplexCostPerSheet),
    blankCostPerPage: pick(p?.blank_cost_per_page, FALLBACK_PRICING.blankCostPerPage),
    greenAiFee: pick(p?.green_ai_fee, FALLBACK_PRICING.greenAiFee),
    cheatsheetPrice: pick(p?.cheatsheet_price, FALLBACK_PRICING.cheatsheetPrice),
    execsumPrice: pick(p?.execsum_price, FALLBACK_PRICING.execsumPrice),
  };
}

export interface PriceableJob {
  pages: number; // billed pages per copy
  copies: number;
  fileType: string; // PDF | IMAGE | PPT | DOC | BLANK
  duplex: boolean;
  aiMode?: AiMode | null;
  greenApplied?: boolean; // Green AI output is being printed
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Used by the kiosk (display) and by create-razorpay-order (the real charge).
 * Duplex is priced per copy: each copy is a separate physical print, so an odd page
 * count leaves one single-sided page in every copy.
 * Eco-ink is free and never appears here.
 */
export function computeJobAmount(job: PriceableJob, cfg: PricingConfig): number {
  const copies = Math.max(1, job.copies || 1);
  if (job.fileType === 'BLANK') return round2(job.pages * copies * cfg.blankCostPerPage);
  if (job.aiMode === 'CHEATSHEET') return round2(copies * cfg.cheatsheetPrice);
  if (job.aiMode === 'EXECSUM') return round2(copies * cfg.execsumPrice);

  const perCopy = job.duplex
    ? Math.floor(job.pages / 2) * cfg.duplexCostPerSheet + (job.pages % 2) * cfg.costPerPage
    : job.pages * cfg.costPerPage;
  return round2(perCopy * copies + (job.greenApplied ? cfg.greenAiFee : 0));
}