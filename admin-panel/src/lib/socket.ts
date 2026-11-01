// One Socket.IO connection for the admin panel (the server puts admins in the "admin" room,
// so every device event arrives here). Listeners live in a registry and are re-attached
// whenever the socket is re-created after a token refresh.
import { io, Socket } from 'socket.io-client';
import { getSession, onSession, refreshNow } from './api';

type Fn = (payload: any) => void;
let socket: Socket | null = null;
const handlers = new Map<string, Set<Fn>>();

function attach(s: Socket) {
  handlers.forEach((fns, event) => fns.forEach((fn) => s.on(event, fn)));
}

function connect() {
  const sess = getSession();
  if (!sess) return;
  const s = io({ auth: { token: sess.accessToken }, transports: ['websocket'] });
  socket = s;
  attach(s);
  s.on('auth:expired', async () => {
    s.disconnect();
    if (await refreshNow()) reconnect();
  });
  s.on('connect_error', async (err: any) => {
    const code = err?.data?.code || err?.message;
    if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN' || code === 'TOKEN_REVOKED') {
      s.disconnect();
      if (await refreshNow()) reconnect();
    }
  });
}

function reconnect() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  connect();
}

onSession((s) => {
  if (!s) {
    socket?.disconnect();
    socket = null;
  } else if (socket && (socket.auth as any)?.token !== s.accessToken) {
    reconnect(); // new access token after a refresh
  }
});

export function getSocket(): Socket | null {
  if (!socket && getSession()) connect();
  return socket;
}

// subscribe to an event while a component is mounted
export function onSocket(event: string, fn: Fn): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(fn);
  const s = getSocket();
  s?.on(event, fn);
  return () => {
    handlers.get(event)?.delete(fn);
    socket?.off(event, fn);
  };
}
