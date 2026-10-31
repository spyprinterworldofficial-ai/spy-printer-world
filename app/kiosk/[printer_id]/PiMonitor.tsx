'use client';

import React, { useEffect, useState } from 'react';

// Written by the Pi once a second while it works (print_jobs.ai_telemetry) — real numbers, not an animation.
export interface PiTelemetry {
  cpu: number[]; // % per core
  freq_mhz?: number | null;
  temp_c?: number | null;
  mem_pct?: number | null;
  stage?: string;
  progress?: number; // 0..1
  started_at?: number; // ms epoch
}

const loadColor = (pct: number) => (pct < 50 ? '#3ddc84' : pct < 80 ? '#ffd60a' : '#ff453a');

function Bar({ label, pct, suffix }: { label: string; pct: number; suffix?: string }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className="pimon-row">
      <span className="pimon-label">{label}</span>
      <div className="pimon-track">
        <div className="pimon-fill" style={{ width: `${v}%`, background: loadColor(v) }} />
      </div>
      <span className="pimon-val">{suffix ?? `${v.toFixed(0)}%`}</span>
    </div>
  );
}

export default function PiMonitor({
  telemetry,
  startedAt,
  title,
}: {
  telemetry?: PiTelemetry | null;
  startedAt: number;
  title: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - (telemetry?.started_at ?? startedAt)) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const cores = telemetry?.cpu?.length ? telemetry.cpu : [0, 0, 0, 0];
  const progress = Math.round((telemetry?.progress ?? 0) * 100);

  return (
    <div className="pimon">
      <div className="pimon-head">
        <span>
          <span className="pimon-dot" /> S.py edge unit &middot; {title}
        </span>
        <span>
          {mm}:{ss}
        </span>
      </div>

      {cores.map((c, i) => (
        <Bar key={i} label={`CPU${i}`} pct={c} />
      ))}
      <Bar label="MEM " pct={telemetry?.mem_pct ?? 0} />
      <div className="pimon-meta">
        <span>{telemetry?.freq_mhz ? `${telemetry.freq_mhz} MHz` : '-- MHz'}</span>
        <span>{telemetry?.temp_c != null ? `${telemetry.temp_c.toFixed(1)} °C` : '-- °C'}</span>
        <span>all cores on-device &middot; no cloud AI</span>
      </div>

      <div className="pimon-stage">
        {telemetry?.stage ?? "Waiting for the printer's AI engine"}
        <span className="pimon-cursor">_</span>
      </div>
      <div className="pimon-track pimon-progress">
        <div className="pimon-fill" style={{ width: `${progress}%`, background: '#36d1dc' }} />
      </div>

      <style>{`
        .pimon { background:#05080b; border:1px solid #1f3a2b; border-radius:8px; padding:10px 12px; margin-top:8px;
                 font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; color:#b7f5d0; }
        .pimon-head { display:flex; justify-content:space-between; color:#3ddc84; margin-bottom:6px; font-weight:600; }
        .pimon-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#3ddc84; margin-right:4px;
                     animation: pimon-pulse 1s ease-in-out infinite; }
        .pimon-row { display:flex; align-items:center; gap:8px; margin:3px 0; }
        .pimon-label { width:38px; color:#7fbf9b; }
        .pimon-val { width:40px; text-align:right; }
        .pimon-track { flex:1; height:10px; background:#10201a; border-radius:2px; overflow:hidden; }
        .pimon-fill { height:100%; transition: width .8s ease-out, background .8s; }
        .pimon-meta { display:flex; justify-content:space-between; gap:8px; color:#7fbf9b; margin-top:4px; flex-wrap:wrap; }
        .pimon-stage { margin-top:8px; color:#e6fff0; }
        .pimon-progress { margin-top:4px; height:6px; flex:none; }
        .pimon-cursor { animation: pimon-blink 1s steps(1) infinite; }
        @keyframes pimon-blink { 50% { opacity:0; } }
        @keyframes pimon-pulse { 50% { opacity:.35; } }
      `}</style>
    </div>
  );
}