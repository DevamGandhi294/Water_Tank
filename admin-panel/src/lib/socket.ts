// One Socket.IO connection for the admin panel (joins the "admin" room on the server).
import { io, Socket } from 'socket.io-client';
import { getSession, onSession, refreshNow } from './api';

let socket: Socket | null = null;

function connect() {
  const s = getSession();
  if (!s) return;
  socket = io({ auth: { token: s.accessToken }, transports: ['websocket'] });
  socket.on('auth:expired', async () => {
    socket?.disconnect();
    if (await refreshNow()) reconnect();
  });
  socket.on('connect_error', async (err: any) => {
    if (['TOKEN_EXPIRED', 'INVALID_TOKEN'].includes(err?.data?.code || err?.message)) {
      socket?.disconnect();
      if (await refreshNow()) reconnect();
    }
  });
}
function reconnect() { socket?.disconnect(); socket = null; connect(); }

onSession((s) => { if (!s) { socket?.disconnect(); socket = null; } });

export function getSocket(): Socket | null {
  if (!socket && getSession()) connect();
  return socket;
}

// subscribe to an event while a component is mounted
export function onSocket(event: string, fn: (payload: any) => void): () => void {
  const s = getSocket();
  if (!s) return () => {};
  s.on(event, fn);
  return () => { s.off(event, fn); };
}
