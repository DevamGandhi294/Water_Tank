import { FormEvent, useState } from 'react';
import { login } from '../lib/api';
import { errText, TankIcon } from '../components/ui';

export default function Login() {
  const [phone, setPhone] = useState('+91');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await login(phone, password); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}><span style={{ color: 'var(--water)' }}><TankIcon size={36} /></span><div><h2>Water Tank Admin</h2><span className="muted small">Super admin login</span></div></div>
        <div><label className="lbl" htmlFor="ph">Phone number</label><input id="ph" className="inp" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" inputMode="tel" /></div>
        <div><label className="lbl" htmlFor="pw">Password</label><input id="pw" className="inp" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
        {error && <div className="err">{error}</div>}
        <button className="btn" disabled={busy || !password}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </div>
  );
}
