import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { ago, fmtDate } from '../lib/format';
import { useLoad } from '../components/ui';

export default function Users() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const list = useLoad<{ items: any[]; total: number; nextCursor: string | null }>(
    () => api('GET', `/admin/users${qs({ q: params.get('q'), role: params.get('role'), blocked: params.get('blocked'), cursor: params.get('cursor'), limit: 50 })}`),
    [params.toString()],
  );
  const setF = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); n.delete('cursor'); return n; });
  useEffect(() => { const t = setTimeout(() => (params.get('q') || '') !== q && setF('q', q), 300); return () => clearTimeout(t); }, [q]);
  return (
    <>
      <div className="head"><h2>Users</h2></div>
      <div className="toolbar">
        <input className="inp grow" placeholder="Search name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="inp" value={params.get('role') || ''} onChange={(e) => setF('role', e.target.value)} aria-label="Role"><option value="">All roles</option><option value="user">Customers</option><option value="super_admin">Admins</option></select>
        <select className="inp" value={params.get('blocked') || ''} onChange={(e) => setF('blocked', e.target.value)} aria-label="Blocked"><option value="">Blocked + active</option><option value="true">Blocked only</option><option value="false">Active only</option></select>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      <div className="tbl"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Tanks</th><th>Last login</th><th>Joined</th></tr></thead>
        <tbody>
          {list.data?.items.map((u) => (
            <tr key={u.id} className="click" onClick={() => nav(`/users/${u.id}`)}>
              <td>{u.fullName}{u.isBlocked && <> <span className="pill bad"><i />Blocked</span></>}<div className="small muted">{u.email || ''}</div></td>
              <td className="mono">{u.phone || '–'}</td>
              <td>{u.role === 'super_admin' ? <span className="pill info"><i />Admin</span> : 'Customer'}</td>
              <td>{u.devicesOwned} owned · {u.devicesShared} shared</td>
              <td className="small">{ago(u.lastLoginAt)}</td>
              <td className="small">{fmtDate(u.createdAt)}</td>
            </tr>
          ))}
          {list.data && list.data.items.length === 0 && <tr><td colSpan={6} className="muted">No users match.</td></tr>}
        </tbody>
      </table></div>
      <div className="between" style={{ marginTop: 10 }}>
        <span className="small muted">{list.loading ? 'Loading…' : `Showing ${list.data?.items.length ?? 0} of ${list.data?.total ?? 0}`}</span>
        <div className="row">
          {params.get('cursor') && <button className="btn ghost sm" onClick={() => setF('cursor', '')}>First page</button>}
          {list.data?.nextCursor && <button className="btn ghost sm" onClick={() => setF('cursor', list.data!.nextCursor!)}>Next page</button>}
        </div>
      </div>
    </>
  );
}
