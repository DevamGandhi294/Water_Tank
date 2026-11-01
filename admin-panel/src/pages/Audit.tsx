import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useLoad } from '../components/ui';

export default function Audit() {
  const [action, setAction] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [stack, setStack] = useState<(string | null)[]>([]);
  const list = useLoad<{ items: any[]; nextCursor: string | null }>(() => api('GET', `/admin/audit${qs({ action, cursor, limit: 50 })}`), [action, cursor]);
  const link = (a: any) => (a.targetType === 'device' ? <Link to={`/devices/${a.targetId}`}>device</Link> : a.targetType === 'user' ? <Link to={`/users/${a.targetId}`}>user</Link> : a.targetType === 'rollout' ? <Link to={`/firmware/rollouts/${a.targetId}`}>rollout #{a.targetId}</Link> : a.targetType);
  return (
    <>
      <div className="head"><h2>Audit log</h2></div>
      <div className="toolbar">
        <select className="inp" value={action} onChange={(e) => { setAction(e.target.value); setCursor(null); setStack([]); }} aria-label="Action">
          <option value="">All actions</option><option value="device.">Devices</option><option value="user.">Users</option><option value="firmware.">Firmware</option><option value="ota.">OTA</option>
        </select>
      </div>
      <div className="tbl"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead><tbody>
        {list.data?.items.map((a) => (
          <tr key={a.id}><td className="small">{fmtDate(a.createdAt)}</td><td>{a.actorName || '–'}</td><td className="mono small">{a.action}</td><td>{link(a)}</td>
            <td className="mono small" style={{ maxWidth: 380, wordBreak: 'break-all' }}>{a.data ? JSON.stringify(a.data) : ''}</td><td className="small muted">{a.ip}</td></tr>
        ))}
        {list.data?.items.length === 0 && <tr><td colSpan={6} className="muted">Nothing yet.</td></tr>}
      </tbody></table></div>
      <div className="row" style={{ marginTop: 10 }}>
        {stack.length > 0 && <button className="btn ghost sm" onClick={() => { const s = [...stack]; setCursor(s.pop() ?? null); setStack(s); }}>Newer</button>}
        {list.data?.nextCursor && <button className="btn ghost sm" onClick={() => { setStack([...stack, cursor]); setCursor(list.data!.nextCursor); }}>Older</button>}
      </div>
    </>
  );
}
