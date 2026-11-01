import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { getSession, logout, onSession, Session } from './lib/api';
import { TankIcon } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Register from './pages/Register';
import DeviceDetail from './pages/DeviceDetail';
import Users from './pages/Users';
import UserDetail from './pages/UserDetail';
import Firmware from './pages/Firmware';
import Rollout from './pages/Rollout';
import Audit from './pages/Audit';

export default function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  useEffect(() => onSession(setSession), []);
  if (!session) return <Login />;
  const nav = [
    ['/', 'Dashboard'], ['/devices', 'Devices'], ['/register', 'Register device'], ['/users', 'Users'], ['/firmware', 'Firmware & OTA'], ['/audit', 'Audit log'],
  ];
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><TankIcon /> Water Tank Admin</div>
        {nav.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}>{label}</NavLink>
        ))}
        <div className="foot">
          <span className="small"><b>{session.user.fullName}</b><br /><span className="muted">{session.user.phone}</span></span>
          <button className="btn ghost sm" onClick={() => logout()}>Log out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/register" element={<Register />} />
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id" element={<UserDetail />} />
          <Route path="/firmware" element={<Firmware />} />
          <Route path="/firmware/rollouts/:id" element={<Rollout />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
