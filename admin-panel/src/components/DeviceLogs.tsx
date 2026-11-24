// "Show logs" card on the device page: the last ~100 Serial Monitor lines of the main board
// (fw 4.4+) or the sender (fw 5.2+), and a live view of the main board.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { onSocket } from '../lib/socket';
import { ago, fmtShort } from '../lib/format';
import { errText, useToast } from './ui';

type BoardLog = { text: string; receivedAt: string; fw: string | null; uptimeS: number | null; missingParts: number } | null;
type Logs = { main: BoardLog; sender: BoardLog; liveUntil: string | null; mainRequestedAt: string | null; senderRequestedAt: string | null };

const MAIN_TIMEOUT_MS = 20_000;
const LIVE_MAX_CHARS = 200_000; // keep the browser light during a long live view

function upText(s: number | null) {
  if (s == null) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export default function DeviceLogs({ deviceId, online, hasSender }: { deviceId: string; online: boolean; hasSender: boolean }) {
  const toast = useToast();
  const [board, setBoard] = useState<'main' | 'sender'>('main');
  const [logs, setLogs] = useState<Logs | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [live, setLive] = useState(false);
  const [liveUntil, setLiveUntil] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  const liveRef = useRef(false);
  liveRef.current = live;

  const load = async () => {
    try { const r = await api<Logs>('GET', `/admin/devices/${deviceId}/logs`); setLogs(r); return r; } catch { return null; }
  };

  useEffect(() => {
    load();
    const offs = [
      onSocket('device:log', (p) => {
        if (p.deviceId !== deviceId) return;
        if (p.board === 'main') { setWaiting(false); setTimedOut(false); }
        load();
      }),
      onSocket('device:log_live', (p) => {
        if (p.deviceId !== deviceId || !liveRef.current) return;
        setLiveText((t) => { const n = t + p.text; return n.length > LIVE_MAX_CHARS ? n.slice(n.indexOf('\n', n.length - LIVE_MAX_CHARS) + 1) : n; });
      }),
    ];
    return () => {
      offs.forEach((o) => o());
      if (liveRef.current) api('POST', `/admin/devices/${deviceId}/logs/live`, { on: false }).catch(() => {});
    };
  }, [deviceId]);

  // main board: no answer in 20 s
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => { setWaiting(false); setTimedOut(true); }, MAIN_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  // live view ends when the board stops (10 min)
  useEffect(() => {
    if (!live || !liveUntil) return;
    const t = setTimeout(() => { setLive(false); setLiveUntil(null); }, Math.max(0, new Date(liveUntil).getTime() - Date.now()));
    return () => clearTimeout(t);
  }, [live, liveUntil]);

  // keep the newest line in view
  const shown = live && board === 'main' ? liveText : (board === 'main' ? logs?.main?.text : logs?.sender?.text) || '';
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const request = async () => {
    setTimedOut(false);
    try {
      const r = await api<Logs>('POST', `/admin/devices/${deviceId}/logs`, { board });
      setLogs(r);
      if (board === 'main') { if (live) stopLive(); setWaiting(true); }
      else toast('Asked the sender. It sends its log the next time it joins Wi-Fi.');
    } catch (e) { toast(errText(e), true); }
  };

  const startLive = async () => {
    try {
      const r = await api<{ liveUntil: string }>('POST', `/admin/devices/${deviceId}/logs/live`, { on: true });
      setLiveText(logs?.main?.text ? `${logs.main.text}${logs.main.text.endsWith('\n') ? '' : '\n'}──── live ────\n` : '');
      setLive(true); setLiveUntil(r.liveUntil);
    } catch (e) { toast(errText(e), true); }
  };
  const stopLive = () => {
    setLive(false); setLiveUntil(null);
    api('POST', `/admin/devices/${deviceId}/logs/live`, { on: false }).catch(() => {});
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(shown); toast('Copied'); } catch { toast('Could not copy', true); }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([shown], { type: 'text/plain' }));
    a.download = `${board}-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const cur = board === 'main' ? logs?.main : logs?.sender;
  const tab = (b: 'main' | 'sender', label: string) => (
    <button className={`btn sm ${board === b ? '' : 'ghost'}`} onClick={() => setBoard(b)}>{label}</button>
  );

  return (
    <div className="card stack" style={{ marginTop: 14 }}>
      <div className="between">
        <h3>Logs</h3>
        <div className="row">{tab('main', 'Main board')}{hasSender && tab('sender', 'Sender')}</div>
      </div>

      <div className="row">
        {board === 'main' ? (
          <>
            <button className="btn sm" disabled={!online || waiting} onClick={request}>{waiting ? 'Waiting for the board…' : 'Show logs'}</button>
            {live
              ? <button className="btn sm danger" onClick={stopLive}>Stop live</button>
              : <button className="btn sm ghost" disabled={!online} onClick={startLive}>Live</button>}
            {live && <span className="pill ok"><i />live{liveUntil ? ` until ${fmtShort(liveUntil)}` : ''}</span>}
            {live && <button className="btn sm ghost" onClick={startLive}>+10 min</button>}
          </>
        ) : (
          <button className="btn sm" onClick={request}>{logs?.senderRequestedAt ? 'Asked, waiting for the sender' : 'Ask sender for logs'}</button>
        )}
        {shown && <button className="btn sm ghost" onClick={copy}>Copy</button>}
        {shown && <button className="btn sm ghost" onClick={download}>Download .txt</button>}
      </div>

      {board === 'main' && !online && <div className="small muted">The device is offline.</div>}
      {board === 'main' && timedOut && <div className="err">No answer from the board in 20 s. It needs main firmware 4.4 or newer.</div>}
      {board === 'sender' && (
        <div className="small muted">
          The sender has Wi-Fi only for a few seconds at power-on and every 6 hours, so its log arrives at its next check-in
          (power-cycle it to get it in about 30 s). Its log is lost on power-off, so after a power-cycle you see only the lines since boot. Needs sender firmware 5.2 or newer.
          {logs?.senderRequestedAt && ` Asked ${ago(logs.senderRequestedAt)}.`}
        </div>
      )}
      {!live && cur && (
        <div className="small muted">
          Received {ago(cur.receivedAt)} ({fmtShort(cur.receivedAt)}){cur.fw ? ` · fw ${cur.fw}` : ''}{cur.uptimeS != null ? ` · board up ${upText(cur.uptimeS)}` : ''}
          {cur.missingParts ? ` · ${cur.missingParts} part(s) lost on the way, click Show logs again` : ''}
        </div>
      )}

      <pre ref={preRef} className="mono" style={{
        margin: 0, padding: 10, minHeight: 120, maxHeight: 460, overflow: 'auto', fontSize: 12, lineHeight: 1.4,
        background: '#0f1b21', color: '#d8e4e8', borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {shown || (live ? 'Waiting for new lines…' : 'No log yet. Click the button above.')}
      </pre>
    </div>
  );
}
