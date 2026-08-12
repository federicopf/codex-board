import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { asCodexError, configureTailscaleServe, getGatewayInfo, getTailscaleStatus, type GatewayInfo, type TailscaleInfo } from "./api";

export function RemoteDialog({ onClose }: { onClose: () => void }) {
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payload = useMemo(() => gateway?.running && tailscale?.baseUrl ? JSON.stringify({ baseUrl: tailscale.baseUrl, token: gateway.token }) : null, [gateway, tailscale]);

  useEffect(() => { void Promise.all([getGatewayInfo(), getTailscaleStatus()]).then(([nextGateway, nextTailscale]) => { setGateway(nextGateway); setTailscale(nextTailscale); }).catch((cause) => setError(asCodexError(cause).message)); }, []);

  async function configure() {
    setBusy(true); setError(null);
    try { setTailscale(await configureTailscaleServe()); setGateway(await getGatewayInfo()); }
    catch (cause) { setError(asCodexError(cause).message); }
    finally { setBusy(false); }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="remote-dialog" role="dialog" aria-modal="true" aria-label="Remote access">
      <header><div><h2>Remote access</h2><p>Private connection through Tailscale</p></div><button onClick={onClose} aria-label="Close">×</button></header>
      {!gateway || !tailscale ? <div className="remote-loading"><div className="spinner" />Checking gateway and Tailscale…</div> : payload ? <>
        <div className="remote-ready"><span>✓</span><div><strong>Ready for mobile</strong><small>{tailscale.dnsName}</small></div></div>
        <div className="pairing-qr"><QRCodeSVG value={payload} size={220} level="M" marginSize={2} /></div>
        <ol><li>Keep Tailscale connected on your phone.</li><li>Open Codex Board Mobile and scan this QR code.</li></ol>
        <p className="remote-security">The QR includes a private device credential. Do not share it or publish screenshots of it.</p>
      </> : <>
        <div className="remote-state"><strong>{!gateway.running ? "Local gateway unavailable" : !tailscale.installed ? "Tailscale is not installed" : !tailscale.online ? "Tailscale is offline" : "Tailscale Serve is not configured"}</strong><p>{gateway.error || tailscale.error || "Codex Board can configure a tailnet-only endpoint without public certificates."}</p></div>
        {tailscale.installed && tailscale.online && gateway.running && <button className="remote-configure" disabled={busy} onClick={() => void configure()}>{busy ? "Configuring…" : "Enable remote access"}</button>}
        {!tailscale.installed && <a href="https://tailscale.com/download/windows" target="_blank" rel="noreferrer">Install Tailscale for Windows ↗</a>}
      </>}
      {error && <div className="dialog-error">{error}</div>}
    </section>
  </div>;
}
