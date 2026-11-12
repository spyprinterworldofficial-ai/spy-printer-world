'use client';
import { useEffect, useState, type ReactNode } from 'react';

/** Plays /public/<src> only if that file exists; otherwise shows the fallback (never an empty player). */
export default function Video({ src, fallback, loop = false, controls = false }: { src: string; fallback: ReactNode; loop?: boolean; controls?: boolean }) {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    fetch(src, { method: 'HEAD' }).then((r) => setExists(r.ok && (r.headers.get('content-type') || '').startsWith('video'))).catch(() => {});
  }, [src]);
  if (!exists) return <>{fallback}</>;
  return (
    <video src={src} className="w-100 rounded-4 border border-secondary" autoPlay={loop} muted={loop} loop={loop} playsInline
      controls={controls} preload="metadata" />
  );
}
