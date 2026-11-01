import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { onSocket } from '../lib/socket';
import type { DeviceRow } from '../lib/types';
import { Level, StatePill, useLoad } from '../components/ui';

export default function Devices() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const status = params.get('status') || '';
  const claimed = params.get('claimed') || '';
  const fw = params.get('fw') || '';
  const cursor = params.get('cursor') || '';
  const list = useLoad<{ items: DeviceRow[]; total: number; nextCursor: string | null }>(
    () => api('GET', `/admin/devices${qs({ q: params.get('q'), status, claimed, fw, cursor, limit: 50 })}`),
    [params.toString()],
  );
  const fwList = useLoad<{ items: { version: string }[] }>(() => api('GET', '/admin/firmware'));

  // keep rows live
  useEffect(() => onSocket('device:state', (p) => list.setData((d) => d && {
    ...d, items: d.items.map((r) => (r.id === p.deviceId ? { ...r, state: { ...r.state, ...p } } : r)),
  })), []);

  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('q') || '') !== q) setParams((p) => { const n = new URLSearchParams(p); if (q) n.set('q', q); else n.delete('q'); n.delete('cursor'); return n; });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const setF = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); n.delete('cursor'); return n; });

  return (
    <>
      <div className="head"><h2>Devices</h2><Link className="btn sm" to="/register">Register device</Link></div>
      <div className="toolbar">
        <input className="inp grow" placeholder="Search serial, MAC, owner or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="inp" value={status} onChange={(e) => setF('status', e.target.value)} aria-label="Status">
          <option value="">All status</option><option>WORK</option><option>FAULT</option><option>DOWN</option><option>CONFIG</option><option>OTA</option><option value="offline">Offline</option>
        </select>
        <select className="inp" value={claimed} onChange={(e) => setF('claimed', e.target.value)} aria-label="Claimed">
          <option value="">Claimed + unclaimed</option><option value="true">Claimed only</option><option value="false">Unclaimed only</option>
        </select>
        <select className="inp" value={fw} onChange={(e) => setF('fw', e.target.value)} aria-label="Firmware">
          <option value="">Any firmware</option>
          {[...new Set((fwList.data?.items || []).map((f) => f.version))].map((v) => <option key={v}>{v}</option>)}
          <option value="unknown">unknown</option>
        </select>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      <div className="tbl">
        <table>
          <thead><tr><th>Serial</th><th>Main MAC</th><th>Sender MAC</th><th>Owner</th><th>Status</th><th>FW</th><th>Level</th></tr></thead>
          <tbody>
            {list.data?.items.map((r) => (
              <tr key={r.id} className="click" onClick={() => nav(`/devices/${r.id}`)}>
                <td className="mono">{r.serial}<div className="small muted" style={{ fontFamily: 'var(--body)' }}>{r.name || ''}</div></td>
                <td className="mono">{r.macMain}</td>
                <td className="mono">{r.macSender}</td>
                <td>{r.owner ? <>{r.owner.fullName}<div className="small muted">{r.owner.phone}</div></> : <span className="muted">Not claimed</span>}</td>
                <td><StatePill s={r.state} disabled={r.isDisabled} /></td>
                <td className="mono">{r.fwVersion || '–'}</td>
                <td><Level pct={r.state.levelPct} cm={r.state.distanceCm} /></td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && <tr><td colSpan={7} className="muted">No devices match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="between" style={{ marginTop: 10 }}>
        <span className="small muted">{list.loading ? 'Loading…' : `Showing ${list.data?.items.length ?? 0} of ${list.data?.total ?? 0}`}</span>
        <div className="row">
          {cursor && <button className="btn ghost sm" onClick={() => setF('cursor', '')}>First page</button>}
          {list.data?.nextCursor && <button className="btn ghost sm" onClick={() => setF('cursor', list.data!.nextCursor!)}>Next page</button>}
        </div>
      </div>
    </>
  );
}
