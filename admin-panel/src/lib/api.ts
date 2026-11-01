// Small fetch wrapper: Bearer token, silent refresh on TOKEN_EXPIRED, typed errors.
const BASE = '/api/v1';
const KEY = 'wt_admin_session';

export interface Session { accessToken: string; refreshToken: string; user: User }
export interface User { id: string; fullName: string; phone: string | null; email: string | null; role: string; hasPassword: boolean; googleLinked: boolean; createdAt: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string) { super(message); }
}

let session: Session | null = load();
const listeners = new Set<(s: Session | null) => void>();

function load(): Session | null {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function save(s: Session | null) {
  session = s;
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  listeners.forEach((l) => l(s));
}
export const getSession = () => session;
export const onSession = (fn: (s: Session | null) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!session) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: session!.refreshToken }) });
        if (!r.ok) { save(null); return false; }
        const j = await r.json();
        save({ ...session!, accessToken: j.accessToken, refreshToken: j.refreshToken });
        return true;
      } catch { return false; } finally { setTimeout(() => { refreshing = null; }, 0); }
    })();
  }
  return refreshing;
}
export const refreshNow = refresh;

export async function api<T = any>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (session) headers.authorization = `Bearer ${session.accessToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (res.ok) return json as T;
  const err = json?.error || { code: 'HTTP_' + res.status, message: res.statusText };
  if (res.status === 401 && retry && session && ['TOKEN_EXPIRED', 'INVALID_TOKEN'].includes(err.code)) {
    if (await refresh()) return api<T>(method, path, body, false);
  }
  if (res.status === 401 || err.code === 'USER_BLOCKED') save(null);
  throw new ApiError(res.status, err.code, err.message, err.field);
}

export async function login(phone: string, password: string) {
  const r = await api<Session>('POST', '/auth/login', { phone, password, deviceLabel: 'Admin panel (web)' });
  if (r.user.role !== 'super_admin') {
    await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${r.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: r.refreshToken }) });
    throw new ApiError(403, 'ADMIN_ONLY', 'This account is not an admin');
  }
  save(r);
  return r;
}

export async function logout() {
  const s = session;
  save(null);
  if (s) await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) }).catch(() => {});
}

export const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : '';
};
