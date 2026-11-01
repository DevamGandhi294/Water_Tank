import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { onSocket } from '../lib/socket';
import { fmtDate, fmtShort } from '../lib/format';
import { errText, useLoad, useToast } from '../components/ui';

const pillFor = (s: string) => (s === 'success' ? 'ok' : s === 'failed' ? 'bad' : s === 'skipped' ? 'gray' : s === 'pending' ? 'gray' : 'warn');

export default function Rollout() {
  const { id } = useParams();
  const toast = useToast();
  const r = useLoad<any>(() => api('GET', `/admin/ota/rollouts/${id}`), [id]);
  useEffect(() => onSocket('ota:progress', (p) => String(p.rolloutId) === id && r.setData((d: any) => d && {
    ...d, devices: d.devices.map((x: any) => (x.deviceId === p.deviceId ? { ...x, status: p.status, error: p.error, updatedAt: new Date().toISOString() } : x)),
  })), [id]);
  const act = async (path: string, ok: string) => { try { await api('POST', `/admin/ota/rollouts/${id}/${path}`); toast(ok); r.reload(); } catch (e) { toast(errText(e), true); } };
  if (r.error) return <div className="err">{r.error}</div>;
  if (!r.data) return <div className="muted">Loading…</div>;
  const o = r.data.rollout;
  const counts = r.data.devices.reduce((a: any, d: any) => ({ ...a, [d.status]: (a[d.status] || 0) + 1 }), {});
  return (
    <>
      <div className="head">
        <h2>Rollout #{o.id} · <span className="mono">{o.version}</span></h2>
        <div className="row">
          {!o.cancelledAt && <button className="btn sm ghost" onClick={() => act('retry', 'Retrying failed devices')}>Retry failed</button>}
          {!o.cancelledAt && <button className="btn sm danger" onClick={() => act('cancel', 'Cancelled')}>Cancel</button>}
          <Link to="/firmware" className="small">Firmware</Link>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row small">
          <span>Started {fmtDate(o.createdAt)} by {o.createdBy || '–'}</span>
          {o.cancelledAt && <span className="pill gray">cancelled {fmtDate(o.cancelledAt)}</span>}
          {Object.entries(counts).map(([k, v]) => <span key={k} className={`pill ${pillFor(k)}`}><i />{k} {String(v)}</span>)}
        </div>
      </div>
      <div className="tbl"><table><thead><tr><th>Device</th><th>From</th><th>Status</th><th>Updated</th></tr></thead><tbody>
        {r.data.devices.map((d: any) => (
          <tr key={d.deviceId}><td><Link to={`/devices/${d.deviceId}`} className="mono">{d.serial}</Link> <span className="small muted">{d.name}</span></td>
            <td className="mono">{d.fromVersion || '?'}</td>
            <td><span className={`pill ${pillFor(d.status)}`}><i />{d.status}</span>{d.error && <span className="small muted"> {d.error}</span>}</td>
            <td className="small">{fmtShort(d.updatedAt)}</td></tr>
        ))}
      </tbody></table></div>
    </>
  );
}
