import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import type { DeviceState } from '../lib/types';
import { ApiError } from '../lib/api';

export function StatePill({ s, disabled }: { s: DeviceState; disabled?: boolean }) {
  if (disabled) return <span className="pill gray"><i />Disabled</span>;
  if (!s.online) return <span className="pill bad"><i />Offline</span>;
  if (s.status === 'WORK') return <span className="pill ok"><i />Online · WORK</span>;
  if (s.status === 'FAULT' || s.status === 'DOWN') return <span className="pill bad"><i />{s.status}</span>;
  return <span className="pill warn"><i />{s.status}</span>;
}

export function Level({ pct, cm }: { pct: number | null; cm: number | null }) {
  if (pct == null) return <span className="mono">{cm != null ? `${cm} cm` : '–'}</span>;
  return <span className="mono"><span className="level"><i style={{ width: `${pct}%` }} /></span>{pct}%</span>;
}

export const sevColor = (s: string) => (s === 'critical' ? 'var(--bad)' : s === 'warning' ? 'var(--warn)' : 'var(--water)');

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

type Toast = { text: string; bad?: boolean } | null;
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const show = useCallback((text: string, bad?: boolean) => {
    setT({ text, bad });
    setTimeout(() => setT((cur) => (cur && cur.text === text ? null : cur)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">{t.text}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');

// load data with a reload() function
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); } catch (e) { setError(errText(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, setData, error, loading, reload };
}

export const TankIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M5 13c2.5-1.5 4.5 1.5 7 0s4.5 1.5 7 0" /></svg>
);
