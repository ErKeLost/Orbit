import { ChevronRight as ArrowRight, Copy, ImagePlus as Image, LoaderCircle, Share as ScanQrCode, X } from "../../shared/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "../UI";
import { Icon } from "../Icon";
import { decodeImageUrl, isScanCanceled, scanQrNative } from "../../lib/qr-scan";
import { parsePairingUri } from "../../lib/remote-protocol";
import "../../styles/remote-access.css";

export type RemotePairingScreenProps = {
  pairingUri: string;
  connecting: boolean;
  error?: string | null;
  onPairingUriChange: (value: string) => void;
  onConnect: (pairingUri: string) => void;
};

/** Mobile pairing surface with camera/file QR entry and a manual URI fallback. */
export function RemotePairingScreen({ pairingUri, connecting, error, onPairingUriChange, onConnect }: RemotePairingScreenProps) {
  const value = pairingUri.trim();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const nativeAbortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const closeScanner = useCallback(() => {
    nativeAbortRef.current?.abort();
    nativeAbortRef.current = null;
    document.documentElement.classList.remove("remote-native-scanning");
    setScannerOpen(false);
    setImageBusy(false);
  }, []);

  useEffect(() => () => {
    nativeAbortRef.current?.abort();
    document.documentElement.classList.remove("remote-native-scanning");
  }, []);

  const acceptScan = useCallback((raw: string | undefined) => {
    const candidate = raw?.trim();
    if (!candidate) return false;
    try {
      parsePairingUri(candidate);
    } catch {
      setScannerError("这不是有效的 Orbit 配对二维码，请扫描电脑端显示的二维码。");
      return false;
    }
    onPairingUriChange(candidate);
    closeScanner();
    return true;
  }, [closeScanner, onPairingUriChange]);

  const startNativeScan = useCallback(async () => {
    nativeAbortRef.current?.abort();
    const abort = new AbortController();
    nativeAbortRef.current = abort;
    setScannerError(null);
    setScannerOpen(true);
    document.documentElement.classList.add("remote-native-scanning");
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    if (abort.signal.aborted) return;
    try {
      const text = await scanQrNative(abort.signal);
      if (!abort.signal.aborted) acceptScan(text);
    } catch (cause) {
      if (abort.signal.aborted || isScanCanceled(cause)) return;
      setScannerError(cause instanceof Error ? cause.message : "无法打开摄像头，请选择二维码图片或粘贴配对链接。");
    } finally {
      if (nativeAbortRef.current === abort) nativeAbortRef.current = null;
    }
  }, [acceptScan]);

  function openScanner() {
    void startNativeScan();
  }

  async function scanFile(file: File | undefined) {
    if (!file) return;
    nativeAbortRef.current?.abort();
    nativeAbortRef.current = null;
    setScannerError(null);
    setImageBusy(true);
    const url = URL.createObjectURL(file);
    try {
      const text = await decodeImageUrl(url);
      if (text) {
        acceptScan(text);
        return;
      }
      setScannerError("没有识别到二维码，请换一张清晰图片。");
    } catch {
      setScannerError("无法读取这张图片，请换一张清晰的二维码截图。");
    } finally {
      URL.revokeObjectURL(url);
      setImageBusy(false);
    }
  }

  return <main className="remote-pairing-screen">
    <section className="remote-pairing-content" aria-labelledby="remote-pairing-title">
      <div className="remote-pairing-brand"><img src="/orbit-mark.png" alt="Orbit" /></div>
      <header className="remote-pairing-heading">
        <p>ORBIT MOBILE</p>
        <h1 id="remote-pairing-title">连接到你的电脑</h1>
        <span>在电脑端开启移动访问，然后扫描或粘贴生成的配对链接。</span>
      </header>
      <Button type="button" variant="outline" className="remote-pairing-scan-card" onClick={() => void openScanner()} disabled={connecting}><span className="remote-pairing-scan-icon"><ScanQrCode aria-hidden="true" /></span><span><strong>扫描二维码</strong><small>扫描电脑端显示的二维码，快速完成配对</small></span><ArrowRight aria-hidden="true" /></Button>
      <div className="remote-pairing-divider"><span>或</span></div>
      <form className="remote-pairing-form" aria-busy={connecting} onSubmit={event => { event.preventDefault(); if (value && !connecting) onConnect(value); }}>
        <label htmlFor="remote-pairing-uri">配对链接</label>
        <div className="remote-pairing-input-shell"><Input id="remote-pairing-uri" value={pairingUri} disabled={connecting} aria-invalid={Boolean(error)} aria-describedby={error ? "remote-pairing-error" : "remote-pairing-help"} autoCapitalize="none" autoComplete="off" autoCorrect="off" enterKeyHint="go" spellCheck={false} placeholder="orbit://pair?host=…" onChange={event => onPairingUriChange(event.target.value)} /><Button type="button" variant="ghost" size="icon" title="复制配对链接" aria-label="复制配对链接" disabled={!value} onClick={() => void navigator.clipboard.writeText(value)}><Copy aria-hidden="true" /></Button></div>
        <p id="remote-pairing-help" className="remote-pairing-help">手机必须能够通过配对链接中的地址访问电脑。</p>
        {(error || scannerError) && <p id="remote-pairing-error" className="remote-pairing-error" role="alert"><Icon name="warning-circle" />{error || scannerError}</p>}
        <Button type="submit" size="lg" variant="outline" className="remote-pairing-connect" disabled={!value || connecting}>{connecting ? <LoaderCircle className="animate-spin" /> : null}{connecting ? "正在连接" : "连接电脑"}</Button>
      </form>
      <p className="remote-pairing-security"><Icon name="shield-check" />配对链接包含访问凭据，请勿分享给其他人。</p>
    </section>
    {scannerOpen && <div className="qr-scanner" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title">
      <div className="qr-scanner-shade" aria-hidden="true" />
      <header className="qr-scanner-topbar">
        <button type="button" className="qr-scanner-close" title="关闭扫码" aria-label="关闭扫码" onClick={closeScanner}><X aria-hidden="true" /></button>
        <div className="qr-scanner-heading" id="qr-scanner-title"><ScanQrCode aria-hidden="true" /><strong>扫描二维码</strong></div>
        <span className="qr-scanner-topbar-spacer" aria-hidden="true" />
      </header>
      <div className="qr-scanner-stage">
        <div className="qr-scanner-frame" aria-hidden="true">
          <span className="qr-scanner-corner is-tl" />
          <span className="qr-scanner-corner is-tr" />
          <span className="qr-scanner-corner is-bl" />
          <span className="qr-scanner-corner is-br" />
          <div className="qr-scanner-beam" />
        </div>
        <p className="qr-scanner-hint">对准电脑屏幕上的配对二维码</p>
        {(imageBusy || scannerError) && <div className={`qr-scanner-status${scannerError ? " is-error" : ""}`} role={scannerError ? "alert" : "status"}>{imageBusy ? <><LoaderCircle className="animate-spin" aria-hidden="true" /><span>正在识别图片…</span></> : <><span>{scannerError}</span><button type="button" onClick={() => void startNativeScan()}>重新扫描</button></>}</div>}
      </div>
      <div className="qr-scanner-actions">
        <button type="button" className="qr-scanner-album" title="从相册选择二维码" aria-label="从相册选择二维码" onClick={() => fileRef.current?.click()}><Image aria-hidden="true" /><span>从相册选择</span></button>
      </div>
      <input ref={fileRef} className="qr-scanner-file-input" type="file" accept="image/*" onChange={event => { void scanFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    </div>}
  </main>;
}
