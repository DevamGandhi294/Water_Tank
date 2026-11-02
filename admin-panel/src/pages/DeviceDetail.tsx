import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { onSocket } from '../lib/socket';
import { ago, fmtDate, fmtShort } from '../lib/format';
import type { DeviceEvent, Settings } from '../lib/types';
import { errText, Level, Modal, sevColor, StatePill, useLoad, useToast } from '../components/ui';
import { downloadPng, Sticker } from './Register';

type Dialog = null | 'claim' | 'unclaim' | 'transfer' | 'board' | 'settings' | 'edit' | 'delete';

export default function DeviceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const dev = useLoad<any>(() => api('GET', `/admin/devices/${id}`), [id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [claim, setClaim] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const offs = [
      onSocket('device:state', (p) => p.deviceId === id && dev.setData((d: any) => d && { ...d, state: { ...d.state, ...p } })),
      onSocket('device:online', (p) => p.deviceId === id && dev.setData((d: any) => d && { ...d, state: { ...d.state, online: p.online } })),
      onSocket('command:result', (p) => p.deviceId === id && dev.reload()),
      onSocket('settings:sync', (p) => p.deviceId === id && dev.reload()),
      onSocket('device:event', (p) => p.deviceId === id && dev.setData((d: any) => d && { ...d, events: [p.event, ...d.events.filter((e: DeviceEvent) => e.id !== p.event.id)].slice(0, 20) })),
    ];
    return () => offs.forEach((o) => o());
  }, [id]);

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { const r = await fn(); toast(ok); dev.reload(); return r; } catch (e) { toast(errText(e), true); } finally { setBusy(false); }
  };
  const command = (type: string) => run(() => api('POST', `/admin/devices/${id}/commands`, { type }), `Sent ${type.replace('_', ' ')}`);

  if (dev.error) return <div className="err">{dev.error}</div>;
  const d = dev.data;
  if (!d) return <div className="muted">Loading…</div>;
  const s: Settings = d.settings;
  const main = d.boards.find((b: any) => b.role === 'main');
  const sender = d.boards.find((b: any) => b.role === 'sender');

  return (
    <>
      <div className="head">
        <h2><span className="mono" style={{ fontSize: 20 }}>{d.serial}</span>{d.name ? ` · ${d.name}` : ''}</h2>
        <div className="row"><StatePill s={d.state} disabled={d.isDisabled} /><Link to="/devices" className="small">All devices</Link></div>
      </div>
      <div className="grid2">
        <div className="card">
          <dl className="kv">
            <dt>Owner</dt><dd>{d.owner ? <Link to={`/users/${d.owner.id}`}>{d.owner.fullName}</Link> : <span className="muted">Not claimed</span>}{d.owner && <span className="muted"> · {d.owner.phone}</span>}</dd>
            <dt>Shared</dt><dd>{d.members.length ? d.members.map((m: any) => `${m.fullName} (${m.permission})`).join(', ') : '–'}</dd>
            <dt>Main board</dt><dd className="mono">{main?.mac} · fw {main?.fwVersion || '?'}</dd>
            <dt>Sender board</dt><dd className="mono">{sender?.mac}</dd>
            <dt>MQTT user</dt><dd className="mono">{d.mqttUsername}</dd>
            <dt>Live</dt><dd><Level pct={d.state.levelPct} cm={d.state.distanceCm} /> · {d.state.distanceCm ?? '–'} cm · pump <b style={{ color: d.state.pumpOn ? 'var(--ok)' : undefined }}>{d.state.pumpOn ? 'ON' : 'OFF'}</b>{d.state.wifiRssi != null ? ` · RSSI ${d.state.wifiRssi}` : ''}</dd>
            <dt>Last seen</dt><dd>{ago(d.state.lastSeenAt)}{d.state.senderOk === false ? ' · sender not heard' : ''}</dd>
            <dt>Settings</dt><dd>Cutoff {s.cutoffCm} cm · height {s.tankHeightCm ?? '–'} cm · auto {s.autoMode ? 'on' : 'off'} · v{s.version} {s.sync === 'applied' ? <span className="pill ok"><i />applied</span> : <span className="pill warn"><i />{s.sync.replace('_', ' ')}</span>}</dd>
            <dt>Location</dt><dd>{d.location || '–'} · {d.timezone}</dd>
            <dt>Registered</dt><dd>{fmtDate(d.createdAt)}{d.claimedAt ? ` · claimed ${fmtDate(d.claimedAt)}` : ''}</dd>
            <dt>Claim code</dt><dd>{d.claimCodeActive ? 'active (on sticker)' : 'none'}</dd>
          </dl>
        </div>
        <div className="card stack">
          <h3>Actions</h3>
          <div className="row">
            <button className="btn sm" disabled={busy || !d.state.online} onClick={() => command('pump_on')}>Pump ON</button>
            <button className="btn sm ghost" disabled={busy || !d.state.online} onClick={() => command('pump_off')}>Pump OFF</button>
            <button className="btn sm ghost" disabled={busy || !d.state.online} onClick={() => command('reboot')}>Reboot</button>
            <button className="btn sm ghost" disabled={busy || !d.state.online} onClick={() => command('config_mode')}>Config mode</button>
            <button className="btn sm ghost" disabled={busy || !d.state.online} onClick={() => command('ota_check')}>OTA check</button>
            <button className="btn sm ghost" disabled={busy || !d.state.online} onClick={() => command('apply_settings')}>Resend settings</button>
          </div>
          {!d.state.online && <div className="small muted">Device is offline, commands are disabled.</div>}
          <div className="row">
            <button className="btn sm ghost" onClick={() => setDialog('settings')}>Edit settings</button>
            <button className="btn sm ghost" onClick={() => setDialog('edit')}>Rename</button>
            <button className="btn sm ghost" onClick={() => run(() => api('POST', `/admin/devices/${id}/claim-code`).then(setClaim).then(() => setDialog('claim')), 'New claim code made')}>New claim code</button>
            <button className="btn sm ghost" onClick={() => setDialog('board')}>Replace board</button>
            <button className="btn sm ghost" onClick={() => setDialog('transfer')}>Transfer</button>
            {d.owner && <button className="btn sm danger" onClick={() => setDialog('unclaim')}>Unclaim</button>}
            <button className="btn sm danger" onClick={() => run(() => api('PATCH', `/admin/devices/${id}`, { isDisabled: !d.isDisabled }), d.isDisabled ? 'Device enabled' : 'Device disabled')}>{d.isDisabled ? 'Enable' : 'Disable'}</button>
            {!d.claimedAt && <button className="btn sm danger" onClick={() => setDialog('delete')}>Delete</button>}
          </div>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Events</h3>
          {d.events.length === 0 && <p className="muted small">No events yet.</p>}
          {d.events.map((e: DeviceEvent) => (
            <div className="ev" key={e.id}><span className="dot" style={{ background: e.resolvedAt ? 'var(--line)' : sevColor(e.severity) }} />
              <div><b>{e.message || e.type}</b><div className="small muted">{fmtShort(e.occurredAt)}{e.resolvedAt ? ` · cleared ${fmtShort(e.resolvedAt)}` : ''}</div></div></div>
          ))}
        </div>
        <div className="stack">
          <div className="card">
            <h3>Commands</h3>
            <div className="tbl" style={{ marginTop: 8 }}><table><thead><tr><th>When</th><th>Type</th><th>By</th><th>Status</th></tr></thead><tbody>
              {d.commands.map((c: any) => <tr key={c.id}><td className="small">{fmtShort(c.createdAt)}</td><td className="mono small">{c.type}</td><td className="small">{c.requestedBy || c.source}</td>
                <td><span className={`pill ${c.status === 'acked' ? 'ok' : c.status === 'failed' || c.status === 'expired' ? 'bad' : 'warn'}`}><i />{c.status}{c.error ? ` · ${c.error}` : ''}</span></td></tr>)}
              {d.commands.length === 0 && <tr><td colSpan={4} className="muted small">None</td></tr>}
            </tbody></table></div>
          </div>
          <div className="card">
            <h3>Settings history</h3>
            {d.settingsHistory.map((h: any) => (
              <div className="ev" key={h.version}><span className="dot" style={{ background: h.appliedAt ? 'var(--ok)' : 'var(--warn)' }} />
                <div><b>v{h.version}</b> {Object.keys(h.new).map((k) => `${k}: ${h.old[k] ?? '–'} → ${h.new[k] ?? '–'}`).join(', ')}
                  <div className="small muted">{h.changedBy || 'system'} · {fmtShort(h.changedAt)} · {h.appliedAt ? `saved on device ${fmtShort(h.appliedAt)}` : 'not confirmed'}</div></div></div>
            ))}
            {d.settingsHistory.length === 0 && <p className="muted small">No changes.</p>}
          </div>
          <div className="card">
            <h3>OTA history</h3>
            {d.otaHistory.map((o: any) => <div key={o.rolloutId} className="between small" style={{ padding: '4px 0' }}><Link to={`/firmware/rollouts/${o.rolloutId}`}>Rollout #{o.rolloutId} · {o.version}</Link><span>{o.status}{o.error ? ` (${o.error})` : ''}</span></div>)}
            {d.otaHistory.length === 0 && <p className="muted small">No updates pushed.</p>}
          </div>
        </div>
      </div>

      {dialog === 'claim' && claim && (
        <Modal title="New claim code" onClose={() => setDialog(null)}>
          <Sticker serial={d.serial} registeredAt={claim.registeredAt || d.createdAt} claimCode={claim.claimCode} png={claim.qrPngBase64} />
          <div className="secret small">Shown only now. The old code no longer works.{claim.note ? ` ${claim.note}` : ''}</div>
          <div className="row"><button className="btn sm ghost" onClick={() => downloadPng(`${d.serial}.png`, claim.qrPngBase64)}>Download QR PNG</button><button className="btn sm" onClick={() => setDialog(null)}>Done</button></div>
        </Modal>
      )}
      {dialog === 'unclaim' && <ReasonDialog title="Unclaim device" label="Reason" action="Unclaim" onClose={() => setDialog(null)} onSubmit={(reason) => run(() => api('POST', `/admin/devices/${id}/unclaim`, { reason }), 'Owner removed').then(() => setDialog(null))} note="The owner and everyone it was shared with lose access. Timers are deleted. A new claim code is needed to add it again." />}
      {dialog === 'transfer' && <ReasonDialog title="Transfer to another account" label="Phone number of the new owner" action="Transfer" initial="+91" onClose={() => setDialog(null)} onSubmit={(toPhone) => run(() => api('POST', `/admin/devices/${id}/transfer`, { toPhone }), 'Transferred').then(() => setDialog(null))} />}
      {dialog === 'board' && <BoardDialog onClose={() => setDialog(null)} onSubmit={(role, mac) => run(() => api('POST', `/admin/devices/${id}/boards`, { role, mac }), 'Board replaced').then(() => setDialog(null))} />}
      {dialog === 'settings' && <SettingsDialog s={s} onClose={() => setDialog(null)} onSubmit={(body) => run(() => api('PATCH', `/admin/devices/${id}/settings`, body), 'Settings saved, sending to device').then(() => setDialog(null))} />}
      {dialog === 'edit' && <EditDialog d={d} onClose={() => setDialog(null)} onSubmit={(body) => run(() => api('PATCH', `/admin/devices/${id}`, body), 'Saved').then(() => setDialog(null))} />}
      {dialog === 'delete' && (
        <Modal title={`Delete ${d.serial}?`} onClose={() => setDialog(null)}>
          <p className="small muted" style={{ margin: 0 }}>Only for devices that were never claimed, for example a mistyped MAC. This cannot be undone.</p>
          <div className="row"><button className="btn danger solid" onClick={() => run(() => api('DELETE', `/admin/devices/${id}`), 'Deleted').then(() => nav('/devices'))}>Delete</button><button className="btn ghost" onClick={() => setDialog(null)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

function ReasonDialog({ title, label, action, note, initial = '', onClose, onSubmit }: { title: string; label: string; action: string; note?: string; initial?: string; onClose: () => void; onSubmit: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      {note && <p className="small muted" style={{ margin: 0 }}>{note}</p>}
      <div><label className="lbl" htmlFor="rv">{label}</label><input id="rv" className="inp" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></div>
      <div className="row"><button className="btn" disabled={!v.trim()} onClick={() => onSubmit(v.trim())}>{action}</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function BoardDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (role: string, mac: string) => void }) {
  const [role, setRole] = useState('sender');
  const [mac, setMac] = useState('');
  return (
    <Modal title="Replace a board" onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>For repairs. The old board is kept in history. The MQTT username stays the same, so a new main board must be flashed to log in with the old username.</p>
      <div><label className="lbl" htmlFor="br">Board</label><select id="br" className="inp" value={role} onChange={(e) => setRole(e.target.value)}><option value="sender">Sender (ultrasonic)</option><option value="main">Main (relay)</option></select></div>
      <div><label className="lbl" htmlFor="bm">New MAC</label><input id="bm" className="inp mono" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="84:F3:EB:20:14:5B" /></div>
      <div className="row"><button className="btn" disabled={!mac} onClick={() => onSubmit(role, mac)}>Replace</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function SettingsDialog({ s, onClose, onSubmit }: { s: Settings; onClose: () => void; onSubmit: (b: any) => void }) {
  const [cutoff, setCutoff] = useState(String(s.cutoffCm));
  const [height, setHeight] = useState(s.tankHeightCm == null ? '' : String(s.tankHeightCm));
  const [auto, setAuto] = useState(s.autoMode);
  const [maxMin, setMaxMin] = useState(s.maxPumpMinutes == null ? '' : String(s.maxPumpMinutes));
  const c = Number(cutoff);
  const hNum = height ? Number(height) : null;
  const problem = c < 25 ? 'Cutoff must be at least 25 cm' : c > 300 ? 'Cutoff can be at most 300 cm' : hNum != null && c >= hNum ? 'Cutoff must be less than the tank height' : '';
  return (
    <Modal title="Edit settings (support)" onClose={onClose}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <div style={{ flex: 1 }}><label className="lbl" htmlFor="sc">Auto cutoff (cm)</label><input id="sc" className="inp" type="number" value={cutoff} onChange={(e) => setCutoff(e.target.value)} /></div>
        <div style={{ flex: 1 }}><label className="lbl" htmlFor="sh">Tank height (cm)</label><input id="sh" className="inp" type="number" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="not set" /></div>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <div style={{ flex: 1 }}><label className="lbl" htmlFor="sm">Max pump run (min)</label><input id="sm" className="inp" type="number" value={maxMin} onChange={(e) => setMaxMin(e.target.value)} placeholder="no limit" /></div>
        <label className="row" style={{ flex: 1, marginTop: 18 }}><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto mode</label>
      </div>
      {problem && <div className="err">{problem}</div>}
      <div className="row"><button className="btn" disabled={!!problem} onClick={() => onSubmit({ cutoffCm: c, tankHeightCm: hNum, autoMode: auto, maxPumpMinutes: maxMin ? Number(maxMin) : null })}>Save and send</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function EditDialog({ d, onClose, onSubmit }: { d: any; onClose: () => void; onSubmit: (b: any) => void }) {
  const [name, setName] = useState(d.name || '');
  const [location, setLocation] = useState(d.location || '');
  const [hwModel, setHwModel] = useState(d.hwModel || '');
  return (
    <Modal title="Rename device" onClose={onClose}>
      <div><label className="lbl" htmlFor="en">Name</label><input id="en" className="inp" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><label className="lbl" htmlFor="el">Location</label><input id="el" className="inp" value={location} onChange={(e) => setLocation(e.target.value)} /></div>
      <div><label className="lbl" htmlFor="eh">Hardware model</label><input id="eh" className="inp" value={hwModel} onChange={(e) => setHwModel(e.target.value)} /></div>
      <div className="row"><button className="btn" onClick={() => onSubmit({ name: name || null, location: location || null, hwModel })}>Save</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
