import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { onSocket } from '../lib/socket';
import { fmtBytes, fmtDate } from '../lib/format';
import { errText, Modal, useLoad, useToast } from '../components/ui';

export default function Firmware() {
  const toast = useToast();
  const rel = useLoad<{ items: any[] }>(() => api('GET', '/admin/firmware'));
  const rollouts = useLoad<{ items: any[] }>(() => api('GET', '/admin/ota/rollouts'));
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [board, setBoard] = useState('main');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<any>(null);

  useEffect(() => onSocket('ota:progress', () => rollouts.reload()), []);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const f = new FormData();
    f.set('version', version); f.set('board', board); f.set('notes', notes); f.set('file', file);
    setBusy(true); setErr('');
    try { await api('POST', '/admin/firmware', f); toast(`Uploaded ${version}`); setFile(null); setVersion(''); setNotes(''); rel.reload(); }
    catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); rel.reload(); rollouts.reload(); } catch (e) { toast(errText(e), true); } };

  return (
    <>
      <div className="head"><h2>Firmware and OTA</h2></div>
      <div className="grid2">
        <form className="card stack" onSubmit={upload}>
          <h3>Upload a release</h3>
          <div><label className="lbl" htmlFor="ff">Firmware file (.bin, max 1 MB)</label><input id="ff" className="inp" type="file" accept=".bin" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <div style={{ flex: 1 }}><label className="lbl" htmlFor="fv">Version</label><input id="fv" className="inp mono" placeholder="1.4" value={version} onChange={(e) => setVersion(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label className="lbl" htmlFor="fb">Board</label><select id="fb" className="inp" value={board} onChange={(e) => setBoard(e.target.value)}><option value="main">Main (relay)</option><option value="sender">Sender</option></select></div>
          </div>
          <div><label className="lbl" htmlFor="fn">Notes</label><textarea id="fn" className="inp" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {err && <div className="err">{err}</div>}
          <button className="btn" disabled={busy || !file || !version}>Upload</button>
          <div className="small muted">The backend stores the file and its sha256. Marking a release stable also updates <span className="mono">/ota/version.json</span>, which v1.3 boards still read.</div>
        </form>
        <div className="card">
          <h3>Rollouts</h3>
          <div className="tbl" style={{ marginTop: 8 }}><table><thead><tr><th>#</th><th>Version</th><th>Progress</th><th>Started</th></tr></thead><tbody>
            {rollouts.data?.items.map((o) => (
              <tr key={o.id}><td><Link to={`/firmware/rollouts/${o.id}`}>#{o.id}</Link></td><td className="mono">{o.version}{o.cancelledAt && <span className="pill gray" style={{ marginLeft: 6 }}>cancelled</span>}</td>
                <td className="small">{o.counts.success}/{o.counts.total} done{o.counts.failed ? ` · ${o.counts.failed} failed` : ''}{o.counts.pending ? ` · ${o.counts.pending} waiting` : ''}</td>
                <td className="small">{fmtDate(o.createdAt)}</td></tr>
            ))}
            {rollouts.data?.items.length === 0 && <tr><td colSpan={4} className="muted small">No rollouts yet</td></tr>}
          </tbody></table></div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Releases</h3>
        <div className="tbl" style={{ marginTop: 8 }}><table><thead><tr><th>Version</th><th>Board</th><th>Size</th><th>sha256</th><th>On devices</th><th>Uploaded</th><th></th></tr></thead><tbody>
          {rel.data?.items.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.version} {r.isStable && <span className="pill ok"><i />stable</span>}<div className="small muted" style={{ fontFamily: 'var(--body)' }}>{r.notes}</div></td>
              <td>{r.board}</td><td className="small">{fmtBytes(r.fileSize)}</td><td className="mono small" title={r.sha256}>{r.sha256.slice(0, 12)}…</td>
              <td>{r.devicesOnIt}</td><td className="small">{fmtDate(r.createdAt)}<div className="muted">{r.uploadedBy}</div></td>
              <td><div className="row">
                <button className="btn sm" onClick={() => setPush(r)}>Push</button>
                {!r.isStable && <button className="btn sm ghost" onClick={() => act(() => api('PATCH', `/admin/firmware/${r.id}`, { isStable: true }), 'Marked stable')}>Mark stable</button>}
                <button className="btn sm danger" onClick={() => act(() => api('DELETE', `/admin/firmware/${r.id}`), 'Deleted')}>Delete</button>
              </div></td>
            </tr>
          ))}
          {rel.data?.items.length === 0 && <tr><td colSpan={7} className="muted small">No releases yet</td></tr>}
        </tbody></table></div>
      </div>
      {push && <PushDialog release={push} onClose={() => setPush(null)} onDone={() => { setPush(null); rollouts.reload(); }} />}
    </>
  );
}

function PushDialog({ release, onClose, onDone }: { release: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'below' | 'all' | 'list'>('below');
  const [below, setBelow] = useState(release.version);
  const [serials, setSerials] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      let body: any = { releaseId: release.id };
      if (mode === 'all') body.targetAll = true;
      else if (mode === 'below') body.filter = { fwBelow: below };
      else {
        const ids: string[] = [];
        for (const s of serials.split(/[\s,]+/).filter(Boolean)) {
          const r = await api<any>('GET', `/admin/devices?q=${encodeURIComponent(s)}&limit=1`);
          if (r.items[0] && r.items[0].serial.toUpperCase() === s.toUpperCase()) ids.push(r.items[0].id);
          else throw new Error(`Unknown serial ${s}`);
        }
        body.deviceIds = ids;
      }
      const r = await api<any>('POST', '/admin/ota/rollouts', body);
      toast(`Rollout #${r.rolloutId}: ${r.devices} devices, ${r.sentNow} sent now`);
      onDone();
    } catch (e) { toast(errText(e), true); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Push ${release.version} (${release.board})`} onClose={onClose}>
      <label className="row"><input type="radio" checked={mode === 'below'} onChange={() => setMode('below')} /> Devices below version <input className="inp mono" style={{ width: 90 }} value={below} onChange={(e) => setBelow(e.target.value)} /></label>
      <label className="row"><input type="radio" checked={mode === 'list'} onChange={() => setMode('list')} /> These serials</label>
      {mode === 'list' && <textarea className="inp mono" rows={3} placeholder="WT-2026-00001, WT-2026-00002" value={serials} onChange={(e) => setSerials(e.target.value)} />}
      <label className="row"><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> All devices</label>
      <p className="small muted" style={{ margin: 0 }}>Online devices get it now. Offline ones get it when they reconnect. Devices already on this version are skipped.</p>
      <div className="row"><button className="btn" disabled={busy} onClick={submit}>Push update</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
