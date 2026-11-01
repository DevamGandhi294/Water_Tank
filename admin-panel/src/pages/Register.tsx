import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { errText, useToast } from '../components/ui';

interface RegResult { device: { id: string }; serial: string; mqttUsername: string; claimCode: string; qrPayload: string; qrPngBase64: string }

export function Sticker({ serial, claimCode, png }: { serial: string; claimCode: string; png: string }) {
  return (
    <div className="sticker">
      <img src={`data:image/png;base64,${png}`} alt={`QR for ${serial}`} />
      <div className="mono small" style={{ lineHeight: 1.6 }}><b style={{ fontSize: 14 }}>{serial}</b><br />Code: {claimCode}<br />Scan in the Water Tank app</div>
    </div>
  );
}

export function downloadPng(name: string, png: string) {
  const a = document.createElement('a');
  a.href = `data:image/png;base64,${png}`;
  a.download = name;
  a.click();
}

function parseCsv(text: string) {
  const rows: { macMain: string; macSender: string }[] = [];
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
    const [a, b] = line.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, ''));
    if (!a || !b || /mac/i.test(a)) return; // skip header
    rows.push({ macMain: a, macSender: b });
  });
  return rows;
}

export default function Register() {
  const toast = useToast();
  const [macMain, setMacMain] = useState('');
  const [macSender, setMacSender] = useState('');
  const [hwModel, setHwModel] = useState('WT-ESP8266-HC12');
  const [made, setMade] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RegResult | null>(null);
  const [bulk, setBulk] = useState<any>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api<RegResult>('POST', '/admin/devices', { macMain, macSender, hwModel, manufacturedAt: made });
      setRes(r); setMacMain(''); setMacSender('');
      toast(`Registered ${r.serial}`);
    } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  };

  const onCsv = async (file: File) => {
    const rows = parseCsv(await file.text());
    if (!rows.length) { setErr('No MAC pairs found. One line per device: mainMAC,senderMAC'); return; }
    setBusy(true); setErr('');
    try { setBulk(await api('POST', '/admin/devices/bulk', { rows })); } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  };

  const printSheet = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(bulk.stickerSheetHtml);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  return (
    <>
      <div className="head"><h2>Register device</h2></div>
      <div className="grid2">
        <form className="card stack" onSubmit={submit}>
          <div><label className="lbl" htmlFor="rm">Main relay board MAC</label><input id="rm" className="inp mono" placeholder="A4:CF:12:9B:42:10" value={macMain} onChange={(e) => setMacMain(e.target.value)} /></div>
          <div><label className="lbl" htmlFor="rs">Sender (ultrasonic) board MAC</label><input id="rs" className="inp mono" placeholder="84:F3:EB:20:14:5B" value={macSender} onChange={(e) => setMacSender(e.target.value)} /></div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <div style={{ flex: 1 }}><label className="lbl" htmlFor="rh">Hardware model</label><input id="rh" className="inp" value={hwModel} onChange={(e) => setHwModel(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label className="lbl" htmlFor="rd">Made on</label><input id="rd" className="inp" type="date" value={made} onChange={(e) => setMade(e.target.value)} /></div>
          </div>
          {err && <div className="err">{err}</div>}
          <button className="btn" disabled={busy || !macMain || !macSender}>Register and make QR</button>
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            Upload CSV of many MAC pairs
            <input type="file" accept=".csv,.txt" hidden onChange={(e) => e.target.files?.[0] && onCsv(e.target.files[0])} />
          </label>
          <div className="small muted">The serial number is given automatically (WT-&lt;year&gt;-00001…). Devices log in to MQTT with the main board MAC, so there is no secret to flash. CSV: one line per device, <span className="mono">mainMAC,senderMAC</span>.</div>
        </form>
        <div className="card stack">
          {res ? (
            <>
              <div className="between"><h3>Registered</h3><span className="pill ok"><i />{res.serial}</span></div>
              <Sticker serial={res.serial} claimCode={res.claimCode} png={res.qrPngBase64} />
              <div className="secret small"><b>The claim code is shown only now.</b> Print the sticker before leaving this page. If it is lost, make a new code on the device page.</div>
              <dl className="kv"><dt>MQTT username</dt><dd className="mono">{res.mqttUsername}</dd><dt>QR text</dt><dd className="mono">{res.qrPayload}</dd></dl>
              <div className="row">
                <button className="btn sm ghost" onClick={() => downloadPng(`${res.serial}.png`, res.qrPngBase64)}>Download QR PNG</button>
                <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(res.claimCode)}>Copy claim code</button>
                <Link className="btn sm ghost" to={`/devices/${res.device.id}`}>Open device</Link>
              </div>
            </>
          ) : bulk ? (
            <>
              <div className="between"><h3>CSV result</h3><span className="small muted">{bulk.created} created · {bulk.failed} failed</span></div>
              {bulk.stickerSheetHtml && <button className="btn sm" onClick={printSheet}>Print sticker sheet</button>}
              <div className="tbl"><table><thead><tr><th>#</th><th>Serial</th><th>Claim code</th><th>Result</th></tr></thead><tbody>
                {bulk.results.map((r: any) => (
                  <tr key={r.row}><td>{r.row}</td><td className="mono">{r.serial || r.macMain}</td><td className="mono">{r.claimCode || ''}</td>
                    <td>{r.ok ? <span className="pill ok"><i />ok</span> : <span className="err">{r.error.message}</span>}</td></tr>
                ))}
              </tbody></table></div>
            </>
          ) : (
            <>
              <h3>Sticker preview</h3>
              <p className="muted small" style={{ margin: 0 }}>After you register, the QR sticker and the one-time claim code appear here.</p>
              <div className="small muted">Errors you may see: <b>This MAC is already registered to WT-2026-00031</b>, or <b>MAC must look like A4:CF:12:9B:42:10</b>.</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
