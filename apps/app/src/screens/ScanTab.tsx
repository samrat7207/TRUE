// Scan tab: read a checker's QR code with the camera, or paste the link.
import { useEffect, useRef, useState } from 'react';
import { parseScanned } from '@true/wallet-core';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerAndroidScanningLibrary, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { BottomTabs, Card, PillButton, Screen, go } from '../ui.tsx';
import { isNativeApp } from '../server.ts';

// The browser's built-in QR reader. It exists in Chrome on Android and macOS, but not everywhere
// (for example not in Chrome on Windows), so the paste box below is always available.
type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => Detector }).BarcodeDetector;

// Open the consent screen for what was scanned or pasted. Returns false if it is not a request.
function open(text: string): boolean {
  const requestUri = parseScanned(text);
  if (requestUri) go(`/consent?request_uri=${encodeURIComponent(requestUri)}`);
  return requestUri !== null;
}

export function Scan() {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [camera, setCamera] = useState<'off' | 'on' | 'failed'>('off');
  const video = useRef<HTMLVideoElement>(null);

  // While the camera is on: look for a QR code a few times a second. Stop the camera when leaving the screen.
  useEffect(() => {
    if (camera !== 'on' || !BarcodeDetectorClass) return;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        video.current.play();
        timer = setInterval(async () => {
          if (!video.current) return;
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0] && !open(found[0].rawValue)) setError('That QR code is not a TRUE request.');
        }, 300);
      })
      .catch(() => setCamera('failed')); // no camera, or permission refused
    return () => {
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [camera]);

  // Android app: the plugin opens the camera and reads the QR code on the phone itself, using the ZXing
  // library that ships inside the app. Nothing is downloaded and no Google Play Services module is needed.
  async function scanNative() {
    setError('');
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Point at the checker's QR code",
        android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING },
      });
      if (!open(result.ScanResult)) setError('That QR code is not a TRUE request.');
    } catch (e) {
      // Cancelled, or the camera permission was refused.
      const message = e instanceof Error ? e.message : String(e);
      setError(/permission|denied/i.test(message)
        ? 'Camera permission was refused. Allow the camera for TRUE in Android Settings > Apps > TRUE > Permissions, or paste the link below.'
        : `Scanning did not finish (${message || 'cancelled'}). You can paste the link below instead.`);
    }
  }

  return (
    <Screen tabs={<BottomTabs active="/scan" />}>
      <h1 className="text-title font-bold leading-tight">Scan</h1>
      <p className="mt-2 mb-5 text-muted">Scan a checker's QR code to share a proof. You see exactly what is asked before anything is sent.</p>

      {isNativeApp && <div className="mb-5"><PillButton onClick={scanNative}>Scan QR with the camera</PillButton></div>}
      <Card className={`mb-5 ${isNativeApp ? 'hidden' : ''}`}>
        {camera === 'on' && BarcodeDetectorClass
          ? <video ref={video} muted playsInline className="aspect-square w-full rounded-row bg-ink object-cover" />
          : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center rounded-row bg-soft p-4 text-center text-small text-muted">
              {!BarcodeDetectorClass && 'Camera scanning is not available in this browser. Paste the link below instead.'}
              {BarcodeDetectorClass && camera === 'off' && 'The camera is off.'}
              {BarcodeDetectorClass && camera === 'failed' && 'Could not use the camera (none found, or permission was refused). Paste the link below instead.'}
            </div>
          )}
        {BarcodeDetectorClass && (
          <div className="mt-3">
            <PillButton kind="secondary" onClick={() => setCamera(camera === 'on' ? 'off' : 'on')}>{camera === 'on' ? 'Stop camera' : 'Start camera'}</PillButton>
          </div>
        )}
      </Card>

      <h2 className="mb-2 font-semibold">Or paste a link</h2>
      <input
        value={link} onChange={(e) => { setLink(e.target.value); setError(''); }} placeholder="Link shown under the checker's QR code"
        className="mb-3 w-full rounded-row border border-line bg-surface px-4 py-3.5 text-small"
      />
      {error && <Card tone="bad" className="mb-3"><span className="text-small text-bad">{error}</span></Card>}
      <PillButton disabled={!link.trim()} onClick={() => { if (!open(link)) setError('That is not a request link.'); }}>Continue</PillButton>
    </Screen>
  );
}
