import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  detectBarcodeFromVideoElement,
  inspectCameraScannerSupport,
  requestPosCameraStream,
  setCameraTorch,
  stopCameraStream,
  type CameraPermissionOutcome,
  type CameraScannerSupport,
} from "../services/cameraBarcodeScanner";

interface CameraBarcodeScannerModalProps {
  onScan: (code: string) => void;
  onClose: () => void;
}

export function CameraBarcodeScannerModal({ onScan, onClose }: CameraBarcodeScannerModalProps) {
  const { lang, dir } = useI18n();
  const ar = lang === "ar";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [permissionState, setPermissionState] = useState<CameraPermissionOutcome | "requesting">("requesting");
  const [support, setSupport] = useState<CameraScannerSupport | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraLabel, setCameraLabel] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [lastScanned, setLastScanned] = useState<string | null>(null);

  const startCamera = useCallback(async (mode: "environment" | "user") => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    setPermissionState("requesting");
    setTorchOn(false);

    const capability = await inspectCameraScannerSupport();
    setSupport(capability);

    const result = await requestPosCameraStream(mode);
    setPermissionState(result.outcome);
    setTorchSupported(result.torchSupported);
    setCameraLabel(result.cameraLabel);

    if (result.outcome === "granted" && result.stream) {
      streamRef.current = result.stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = result.stream;
        try {
          await video.play();
        } catch {
          /* autoplay handled by user gesture */
        }
      }
    }
  }, []);

  useEffect(() => {
    void startCamera(facingMode);
    return () => {
      stopCameraStream(streamRef.current);
      streamRef.current = null;
    };
  }, [facingMode, startCamera]);

  useEffect(() => {
    if (permissionState !== "granted") return;
    let active = true;
    let timer: number | undefined;

    const tick = async () => {
      if (!active) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas) {
        const hit = await detectBarcodeFromVideoElement(video, canvas);
        if (active && hit?.rawValue) {
          setLastScanned(hit.rawValue);
          if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
            try {
              navigator.vibrate(60);
            } catch {
              /* ignore */
            }
          }
          onScan(hit.rawValue);
          onClose();
          return;
        }
      }
      if (active) {
        timer = window.setTimeout(() => {
          void tick();
        }, 180);
      }
    };

    timer = window.setTimeout(() => {
      void tick();
    }, 220);

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [permissionState, onScan, onClose]);

  const toggleTorch = async () => {
    const next = !torchOn;
    const applied = await setCameraTorch(streamRef.current, next);
    if (applied) setTorchOn(next);
  };

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = manualCode.trim();
    if (!cleaned) return;
    onScan(cleaned);
    onClose();
  };

  return (
    <div
      dir={dir}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/75 p-3 backdrop-blur-xs"
      data-testid="pos-camera-scanner-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ar ? "ماسح الباركود بالكاميرا" : "Camera Barcode Scanner"}
        className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-stone-800 bg-[#161311] text-[#f3ede1] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-black tracking-tight text-[#f3ede1]">
              {ar ? "مسح الباركود بالكاميرا" : "Camera Barcode Scanner"}
            </h2>
            <p className="mt-0.5 truncate text-[11px] font-medium text-stone-400">
              {cameraLabel || (ar ? "وجّه الكاميرا نحو باركود المنتج أو الفاتورة" : "Point the camera at a product or receipt barcode")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={ar ? "إغلاق" : "Close"}
            data-testid="pos-camera-scanner-close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-sm font-bold text-stone-200 hover:bg-white/20"
          >
            ✕
          </button>
        </div>

        {/* Camera Viewport */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
            data-testid="pos-camera-video"
          />
          <canvas ref={canvasRef} className="hidden" aria-hidden />

          {permissionState === "granted" ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-6">
              <div className="relative h-40 w-full max-w-[17rem] rounded-2xl border-2 border-[#b08d57] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
                <div className="absolute inset-x-3 top-1/2 h-0.5 -translate-y-1/2 animate-pulse bg-rose-500 shadow-[0_0_8px_#f43f5e]" />
              </div>
              <span className="mt-3 rounded-full bg-black/70 px-3 py-1 text-[11px] font-bold text-[#dfc08a]">
                {ar ? "جاري المسح التلقائي (Code 128 · EAN-13 · QR)…" : "Auto-scanning (Code 128 · EAN-13 · QR)…"}
              </span>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950/90 p-5 text-center">
              {permissionState === "requesting" ? (
                <>
                  <span className="h-8 w-8 animate-spin rounded-full border-2 border-stone-600 border-t-[#b08d57]" />
                  <p className="text-xs font-bold text-stone-200">
                    {ar ? "يرجى السماح بصلاحية الكاميرا للمتابعة…" : "Please allow camera permission to continue…"}
                  </p>
                </>
              ) : permissionState === "denied" ? (
                <div data-testid="pos-camera-permission-denied" className="space-y-2">
                  <p className="text-sm font-black text-amber-300">
                    {ar ? "تم رفض صلاحية الكاميرا" : "Camera Permission Denied"}
                  </p>
                  <p className="text-xs leading-relaxed text-stone-300">
                    {ar
                      ? "لتفعيل المسح بالكاميرا على هاتف Android: افتح إعدادات الهاتف > التطبيقات > ALYQ POS > الأذونات > الكاميرا > سماح، ثم اضغط إعادة المحاولة."
                      : "To enable camera scanning on Android: open Phone Settings > Apps > ALYQ POS > Permissions > Camera > Allow, then tap Retry."}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startCamera(facingMode)}
                    data-testid="pos-camera-retry"
                    className="mt-2 inline-flex h-9 items-center rounded-xl bg-[#b08d57] px-4 text-xs font-black text-[#161311]"
                  >
                    {ar ? "إعادة طلب الصلاحية" : "Retry Permission"}
                  </button>
                </div>
              ) : (
                <div data-testid="pos-camera-unavailable" className="space-y-2">
                  <p className="text-sm font-black text-amber-300">
                    {ar ? "الكاميرا غير متاحة على هذا الجهاز" : "Camera Unavailable on This Device"}
                  </p>
                  <p className="text-xs leading-relaxed text-stone-300">
                    {permissionState === "in_use"
                      ? ar
                        ? "الكاميرا مستخدمة حالياً بواسطة تطبيق آخر. أغلق التطبيق الآخر ثم أعد المحاولة."
                        : "The camera is currently in use by another app. Close it and retry."
                      : ar
                        ? "لم يتم العثور على كاميرا متاحة أو أن المتصفح لا يدعم البث المباشر. يمكنك إدخال الباركود يدوياً أدناه."
                        : "No camera hardware was detected. You can enter or scan the barcode below."}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startCamera(facingMode)}
                    data-testid="pos-camera-retry"
                    className="mt-2 inline-flex h-9 items-center rounded-xl bg-white/15 px-4 text-xs font-bold text-white"
                  >
                    {ar ? "إعادة المحاولة" : "Retry"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Camera Toolbar & Engine Status */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/5 px-4 py-2.5 text-[11px]">
          <div className="flex items-center gap-1.5" data-testid="pos-camera-engine-status">
            <span
              className={`h-2 w-2 rounded-full ${
                support?.activeEngine === "native-barcode-detector"
                  ? "bg-emerald-400"
                  : support?.activeEngine === "software-canvas-1d"
                    ? "bg-sky-400"
                    : "bg-amber-400"
              }`}
            />
            <span className="font-semibold text-stone-300">
              {support?.activeEngine === "native-barcode-detector"
                ? ar
                  ? "محرك Android الأصلي (BarcodeDetector)"
                  : "Native BarcodeDetector"
                : ar
                  ? "محرك فك التشفير المدمج (Code128 / EAN-13)"
                  : "Built-in 1D Decoder (Code128 / EAN-13)"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFacingMode((prev) => (prev === "environment" ? "user" : "environment"))}
              data-testid="pos-camera-switch"
              className="inline-flex h-8 items-center gap-1 rounded-xl border border-white/15 bg-white/10 px-2.5 text-[11px] font-bold text-stone-100 hover:bg-white/20"
            >
              🔄 {facingMode === "environment" ? (ar ? "الكاميرا الأمامية" : "Front Cam") : (ar ? "الكاميرا الخلفية" : "Rear Cam")}
            </button>
            {torchSupported ? (
              <button
                type="button"
                onClick={() => void toggleTorch()}
                data-testid="pos-camera-torch"
                className={`inline-flex h-8 items-center gap-1 rounded-xl px-2.5 text-[11px] font-bold ${
                  torchOn ? "bg-amber-400 text-stone-950" : "border border-white/15 bg-white/10 text-stone-100"
                }`}
              >
                ⚡ {ar ? "الفلاش" : "Torch"}
              </button>
            ) : null}
          </div>
        </div>

        {/* Manual / Instant Barcode Entry Fallback */}
        <form onSubmit={submitManual} className="space-y-2 p-4">
          <label className="block text-[11px] font-bold text-stone-300">
            {ar ? "أو أدخل رقم الباركود / SKU مباشرة:" : "Or enter Barcode / SKU directly:"}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              dir="ltr"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="ALYQ-RNG-001 / 6291041500213"
              data-testid="pos-camera-manual-input"
              className="h-10 flex-1 rounded-xl border border-white/15 bg-white/10 px-3 font-mono text-xs font-bold text-white outline-none placeholder:text-stone-500 focus:border-[#b08d57]"
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              data-testid="pos-camera-manual-submit"
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl bg-[#b08d57] px-4 text-xs font-black text-[#161311] disabled:opacity-40"
            >
              {ar ? "إضافة للسلة" : "Add to Cart"}
            </button>
          </div>
          {lastScanned ? (
            <p className="text-[11px] font-semibold text-emerald-400">
              {ar ? `آخر باركود تم مسحه: ${lastScanned}` : `Last scanned: ${lastScanned}`}
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
}
