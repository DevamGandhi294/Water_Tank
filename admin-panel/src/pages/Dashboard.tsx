import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { onSocket } from '../lib/socket';
import { ago } from '../lib/format';
import type { Stats } from '../lib/types';
import { sevColor, useLoad } from '../components/ui';

const COLORS = ['var(--water)', 'var(--water-2)', '#9fb4bc', 'var(--line)', '#c9d6da'];

export default function Dashboard() {
  const stats = useLoad<Stats>(() => api('GET', '/admin/stats'));
  const events = useLoad<{ items: any[] }>(() => api('GET', '/admin/events?severity=warning,critical&open=true&limit=15'));
  useEffect(() => onSocket('admin:stats', (s: Stats) => stats.setData(s)), []);
  useEffect(() => onSocket('device:event', () => events.reload()), []);
  const s = stats.data;
  const fwTotal = s ? s.fwVersions.reduce((a, x) => a + x.count, 0) : 0;
  return (
    <>
      <div className="head"><h2>Dashboard</h2><span className="small muted">Live, updates every 10 s</span></div>
      {stats.error && <div className="err">{stats.error}</div>}
      <div className="tiles">
        <div className="card tile"><span>Total devices</span><b>{s?.totalDevices ?? '–'}</b><em className="small muted">{s ? `${s.claimedDevices} claimed` : ''}</em></div>
        <div className="card tile"><span>Online now</span><b>{s?.onlineDevices ?? '–'}</b><em className="small" style={{ color: 'var(--ok)' }}>{s && s.claimedDevices ? `${Math.round((s.onlineDevices / s.claimedDevices) * 100)}% of claimed` : ''}</em></div>
        <div className="card tile"><span>Faulty</span><b style={{ color: s?.faultyDevices ? 'var(--bad)' : undefined }}>{s?.faultyDevices ?? '–'}</b><em className="small muted">FAULT or DOWN</em></div>
        <div className="card tile"><span>Active users</span><b>{s?.activeUsers ?? '–'}</b><em className="small muted">{s ? `${s.usersActive30d} in last 30 days` : ''}</em></div>
      </div>
      <div className="grid2">
        <div className="card stack">
          <h3>Firmware on main boards</h3>
          <div className="bar">{s?.fwVersions.map((f, i) => <i key={f.version} style={{ width: `${(f.count / (fwTotal || 1)) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${f.version}: ${f.count}`} />)}</div>
          <div className="row small muted">{s?.fwVersions.map((f, i) => <span key={f.version}><b style={{ color: COLORS[i % COLORS.length] }}>■</b> {f.version} · {f.count}</span>)}</div>
        </div>
        <div className="card">
          <div className="between"><h3>Open faults</h3><span className="small muted">{s?.openEvents ?? 0} open</span></div>
          {events.data?.items.length === 0 && <p className="muted small">No open faults.</p>}
          {events.data?.items.map((e) => (
            <div className="ev" key={e.id}>
              <span className="dot" style={{ background: sevColor(e.severity) }} />
              <div style={{ flex: 1 }}>
                <div className="between"><Link to={`/devices/${e.deviceId}`} className="mono">{e.serial}</Link><span className="small muted">{ago(e.occurredAt)}</span></div>
                <div>{e.message || e.type}</div>
                <div className="small muted">{e.owner ? `${e.owner.fullName} · ${e.owner.phone}` : 'Not claimed'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
