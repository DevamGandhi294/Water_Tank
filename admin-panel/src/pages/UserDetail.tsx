import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getSession } from '../lib/api';
import { fmtDate, fmtShort } from '../lib/format';
import { errText, Level, Modal, StatePill, useLoad, useToast } from '../components/ui';

export default function UserDetail() {
  const { id } = useParams();
  const toast = useToast();
  const u = useLoad<any>(() => api('GET', `/admin/users/${id}`), [id]);
  const [dialog, setDialog] = useState<null | 'block' | 'password' | 'name'>(null);
  const [val, setVal] = useState('');
  const me = getSession()?.user.id;

  const run = async (fn: () => Promise<any>, ok: string) => {
    try { await fn(); toast(ok); setDialog(null); setVal(''); u.reload(); } catch (e) { toast(errText(e), true); }
  };
  if (u.error) return <div className="err">{u.error}</div>;
  const d = u.data;
  if (!d) return <div className="muted">Loading…</div>;
  const deviceRow = (x: any) => (
    <tr key={x.id}><td><Link to={`/devices/${x.id}`} className="mono">{x.serial}</Link><div className="small muted">{x.name}</div></td><td>{x.access}</td><td><StatePill s={x.state} disabled={x.isDisabled} /></td><td><Level pct={x.state.levelPct} cm={x.state.distanceCm} /></td></tr>
  );
  return (
    <>
      <div className="head">
        <h2>{d.fullName} {d.isBlocked && <span className="pill bad"><i />Blocked</span>} {d.role === 'super_admin' && <span className="pill info"><i />Admin</span>}</h2>
        <Link to="/users" className="small">All users</Link>
      </div>
      <div className="grid2">
        <div className="card">
          <dl className="kv">
            <dt>Phone</dt><dd className="mono">{d.phone || '–'}</dd>
            <dt>Email</dt><dd>{d.email || '–'}</dd>
            <dt>Login</dt><dd>{d.hasPassword ? 'Phone + password' : 'No password'}{d.googleLinked ? ' · Google' : ''}</dd>
            <dt>Joined</dt><dd>{fmtDate(d.createdAt)}</dd>
            <dt>Last login</dt><dd>{fmtDate(d.lastLoginAt)}</dd>
            {d.isBlocked && <><dt>Blocked</dt><dd>{fmtDate(d.blockedAt)} · {d.blockedReason}</dd></>}
            {d.deletedAt && <><dt>Deleted</dt><dd>{fmtDate(d.deletedAt)}</dd></>}
          </dl>
        </div>
        <div className="card stack">
          <h3>Actions</h3>
          <div className="row">
            <button className="btn sm ghost" onClick={() => { setVal(d.fullName); setDialog('name'); }}>Rename</button>
            <button className="btn sm ghost" onClick={() => setDialog('password')}>Set new password</button>
            <button className="btn sm ghost" onClick={() => run(() => api('POST', `/admin/users/${id}/logout-all`), 'Logged out everywhere')}>Log out all phones</button>
            {d.id !== me && (d.isBlocked
              ? <button className="btn sm ghost" onClick={() => run(() => api('POST', `/admin/users/${id}/unblock`), 'Unblocked')}>Unblock</button>
              : <button className="btn sm danger" onClick={() => setDialog('block')}>Block</button>)}
            {d.id !== me && <button className="btn sm ghost" onClick={() => run(() => api('PATCH', `/admin/users/${id}`, { role: d.role === 'super_admin' ? 'user' : 'super_admin' }), 'Role changed')}>{d.role === 'super_admin' ? 'Remove admin role' : 'Make admin'}</button>}
          </div>
          <div className="small muted">There is no SMS reset yet. When a customer forgets the password, set a new one here and tell them on the phone. It logs them out everywhere.</div>
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card stack">
          <h3>Tanks</h3>
          <div className="tbl"><table><thead><tr><th>Serial</th><th>Access</th><th>Status</th><th>Level</th></tr></thead><tbody>
            {[...d.ownedDevices, ...d.sharedDevices].map(deviceRow)}
            {d.ownedDevices.length + d.sharedDevices.length === 0 && <tr><td colSpan={4} className="muted small">No tanks</td></tr>}
          </tbody></table></div>
          <h3>Logged-in phones</h3>
          {d.sessions.map((s: any) => <div key={s.id} className="between small"><span>{s.deviceLabel || 'Unknown'}</span><span className="muted">{s.ip || ''} · {fmtShort(s.createdAt)}</span></div>)}
          {d.sessions.length === 0 && <span className="muted small">None</span>}
        </div>
        <div className="card">
          <h3>Recent notifications</h3>
          {d.notifications.map((n: any) => <div key={n.id} className="ev"><div><b>{n.title}</b><div className="small muted">{n.body} · {fmtShort(n.createdAt)}</div></div></div>)}
          {d.notifications.length === 0 && <p className="muted small">None</p>}
        </div>
      </div>
      {dialog && (
        <Modal title={dialog === 'block' ? 'Block user' : dialog === 'password' ? 'Set new password' : 'Rename user'} onClose={() => setDialog(null)}>
          {dialog === 'block' && <p className="small muted" style={{ margin: 0 }}>The user is logged out at once and cannot log in until unblocked.</p>}
          <div><label className="lbl" htmlFor="v">{dialog === 'block' ? 'Reason' : dialog === 'password' ? 'New password (at least 8 characters)' : 'Full name'}</label>
            <input id="v" className="inp" type={dialog === 'password' ? 'text' : 'text'} value={val} onChange={(e) => setVal(e.target.value)} autoFocus /></div>
          <div className="row">
            <button className={`btn ${dialog === 'block' ? 'danger solid' : ''}`} disabled={dialog === 'password' ? val.length < 8 : !val.trim()}
              onClick={() => run(() => dialog === 'block' ? api('POST', `/admin/users/${id}/block`, { reason: val })
                : dialog === 'password' ? api('POST', `/admin/users/${id}/password`, { newPassword: val })
                  : api('PATCH', `/admin/users/${id}`, { fullName: val }), 'Saved')}>
              {dialog === 'block' ? 'Block' : 'Save'}
            </button>
            <button className="btn ghost" onClick={() => setDialog(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}
