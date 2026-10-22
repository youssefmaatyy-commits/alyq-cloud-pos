/**
 * Camera Barcode Scanner Service for ALYQ POS (Android WebView + Web).
 *
 * Provides:
 *   1. Device & WebView capability inspection (`inspectCameraScannerSupport`)
 *   2. Explicit camera permission management (`requestPosCameraStream`) for
 *      Android Capacitor WebView (`android.permission.CAMERA` via
 *      `BridgeWebChromeClient.onPermissionRequest`) and mobile browsers
 *   3. Multi-engine frame decoding:
 *      - Primary: Hardware-accelerated `window.BarcodeDetector` (MLKit / Shape
 *        Detection API in Android System WebView)
 *      - Fallback: Pure-TypeScript 1D Canvas Scanline Decoder supporting
 *        Code 128 (Subset B & C with Modulo-103 checksum) and EAN-13 / UPC-A
 *        (with Modulo-10 check digit), ensuring every ALYQ SKU/receipt barcode
 *        and retail EAN-13 barcode scans even on Android devices without
 *        Google Play Services BarcodeDetector.
 */

const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
] as const;

const CODE128_PATTERN_TO_VALUE = new Map<string, number>();
for (let i = 0; i <= 105; i += 1) {
  CODE128_PATTERN_TO_VALUE.set(CODE128_PATTERNS[i], i);
}

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;

const EAN_L_CODES = new Map<string, number>([
  ["3211", 0], ["2221", 1], ["2122", 2], ["1411", 3], ["1132", 4],
  ["1231", 5], ["1114", 6], ["1312", 7], ["1213", 8], ["3112", 9],
]);
const EAN_G_CODES = new Map<string, number>([
  ["1123", 0], ["1222", 1], ["2212", 2], ["1141", 3], ["2311", 4],
  ["1321", 5], ["4111", 6], ["2131", 7], ["3121", 8], ["2113", 9],
]);
const EAN_R_CODES = new Map<string, number>([
  ["3211", 0], ["2221", 1], ["2122", 2], ["1411", 3], ["1132", 4],
  ["1231", 5], ["1114", 6], ["1312", 7], ["1213", 8], ["3112", 9],
]);
const EAN_FIRST_DIGIT_PARITY = new Map<string, number>([
  ["LLLLLL", 0], ["LLGLGG", 1], ["LLGGLG", 2], ["LLGGGL", 3], ["LGLLGG", 4],
  ["LGGLLG", 5], ["LGGGLL", 6], ["LGLGLG", 7], ["LGLGGL", 8], ["LGGLGL", 9],
]);

export type CameraPermissionOutcome =
  | "granted"
  | "denied"
  | "not_found"
  | "in_use"
  | "unsupported";

export type BarcodeDecoderEngine =
  | "native-barcode-detector"
  | "software-canvas-1d"
  | "unavailable";

export interface CameraScannerSupport {
  cameraApiAvailable: boolean;
  nativeDetectorAvailable: boolean;
  supportedFormats: string[];
  activeEngine: BarcodeDecoderEngine;
}

export interface CameraStreamResult {
  outcome: CameraPermissionOutcome;
  stream: MediaStream | null;
  torchSupported: boolean;
  cameraLabel: string | null;
  errorMessage: string | null;
}

interface NativeBarcodeDetectorInstance {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string; format?: string }>>;
}

interface NativeBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): NativeBarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

const TARGET_FORMATS = [
  "code_128",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_39",
  "itf",
  "qr_code",
] as const;

function getNativeBarcodeDetectorCtor(): NativeBarcodeDetectorConstructor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as Window & { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export async function inspectCameraScannerSupport(): Promise<CameraScannerSupport> {
  const cameraApiAvailable =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");

  const ctor = getNativeBarcodeDetectorCtor();
  let supportedFormats: string[] = [];
  if (ctor) {
    try {
      if (typeof ctor.getSupportedFormats === "function") {
        const list = await ctor.getSupportedFormats();
        if (Array.isArray(list)) {
          supportedFormats = list.filter((f) => TARGET_FORMATS.includes(f as (typeof TARGET_FORMATS)[number]));
        }
      } else {
        supportedFormats = [...TARGET_FORMATS];
      }
    } catch {
      supportedFormats = [];
    }
  }

  const nativeDetectorAvailable = Boolean(ctor && supportedFormats.length > 0);
  const activeEngine: BarcodeDecoderEngine = nativeDetectorAvailable
    ? "native-barcode-detector"
    : cameraApiAvailable
      ? "software-canvas-1d"
      : "unavailable";

  return {
    cameraApiAvailable,
    nativeDetectorAvailable,
    supportedFormats: nativeDetectorAvailable ? supportedFormats : ["code_128", "ean_13", "upc_a"],
    activeEngine,
  };
}

export function classifyCameraError(error: unknown): CameraPermissionOutcome {
  if (!error || typeof error !== "object") return "unsupported";
  const name = String((error as { name?: unknown }).name ?? "");
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError" ||
    message.includes("permission") ||
    message.includes("denied")
  ) {
    return "denied";
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError" ||
    message.includes("not found")
  ) {
    return "not_found";
  }
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    message.includes("in use") ||
    message.includes("could not start")
  ) {
    return "in_use";
  }
  return "unsupported";
}

export async function requestPosCameraStream(
  facingMode: "environment" | "user" = "environment",
): Promise<CameraStreamResult> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    return {
      outcome: "unsupported",
      stream: null,
      torchSupported: false,
      cameraLabel: null,
      errorMessage: "Camera API unavailable in this environment",
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    const track = stream.getVideoTracks?.()[0] ?? null;
    let torchSupported = false;
    if (track && typeof track.getCapabilities === "function") {
      try {
        const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
        torchSupported = Boolean(caps && caps.torch);
      } catch {
        torchSupported = false;
      }
    }
    return {
      outcome: "granted",
      stream,
      torchSupported,
      cameraLabel: track?.label || null,
      errorMessage: null,
    };
  } catch (error) {
    return {
      outcome: classifyCameraError(error),
      stream: null,
      torchSupported: false,
      cameraLabel: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function setCameraTorch(stream: MediaStream | null, enabled: boolean): Promise<boolean> {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || typeof track.applyConstraints !== "function") return false;
  try {
    await track.applyConstraints({
      advanced: [{ torch: enabled } as MediaTrackConstraintSet],
    });
    return true;
  } catch {
    return false;
  }
}

export function stopCameraStream(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch {
    /* ignore */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure-TypeScript 1D Scanline Decoder (Code 128 & EAN-13 / UPC-A)
// ═══════════════════════════════════════════════════════════════════════════

interface Run {
  isBar: boolean;
  length: number;
}

/** Convert a binary black/white row (true = black bar, false = white space) into runs. */
export function binaryRowToRuns(binary: readonly boolean[]): Run[] {
  const runs: Run[] = [];
  if (binary.length === 0) return runs;
  let current = binary[0];
  let count = 1;
  for (let i = 1; i < binary.length; i += 1) {
    if (binary[i] === current) {
      count += 1;
    } else {
      runs.push({ isBar: current, length: count });
      current = binary[i];
      count = 1;
    }
  }
  runs.push({ isBar: current, length: count });
  return runs;
}

function quantizePattern(runs: readonly Run[], startIdx: number, count: number, totalModules: number): string | null {
  if (startIdx + count > runs.length) return null;
  let totalPixels = 0;
  for (let i = 0; i < count; i += 1) {
    totalPixels += runs[startIdx + i].length;
  }
  if (totalPixels < totalModules * 0.75) return null;
  const moduleWidth = totalPixels / totalModules;

  const widths: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const raw = Math.round(runs[startIdx + i].length / moduleWidth);
    const clamped = Math.max(1, Math.min(4, raw));
    widths.push(clamped);
    sum += clamped;
  }

  // Adjust by at most 1 module if rounding drifted by ±1
  if (sum !== totalModules && Math.abs(sum - totalModules) === 1) {
    let bestIdx = 0;
    let bestDiff = -1;
    for (let i = 0; i < count; i += 1) {
      const exact = runs[startIdx + i].length / moduleWidth;
      const diff = sum < totalModules ? exact - widths[i] : widths[i] - exact;
      if (diff > bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const adjusted = widths[bestIdx] + (sum < totalModules ? 1 : -1);
    if (adjusted >= 1 && adjusted <= 4) {
      widths[bestIdx] = adjusted;
      sum = totalModules;
    }
  }
  if (sum !== totalModules) return null;
  return widths.join("");
}

/** Decode a Code 128 symbol from a sequence of alternating bar/space runs. */
export function decodeCode128FromRuns(runs: readonly Run[]): string | null {
  // Every Code 128 symbol starts on a bar and has 6 runs per character + 7 runs for STOP.
  for (let start = 0; start <= runs.length - 19; start += 1) {
    if (!runs[start].isBar) continue;
    const startPattern = quantizePattern(runs, start, 6, 11);
    if (!startPattern) continue;
    const startCode = CODE128_PATTERN_TO_VALUE.get(startPattern);
    if (startCode !== START_B && startCode !== START_C) continue;

    const codes: number[] = [startCode];
    let cursor = start + 6;
    let foundStop = false;

    while (cursor + 6 <= runs.length) {
      if (cursor + 7 <= runs.length) {
        const stopPattern = quantizePattern(runs, cursor, 7, 13);
        if (stopPattern === CODE128_PATTERNS[106]) {
          foundStop = true;
          break;
        }
      }
      const pattern = quantizePattern(runs, cursor, 6, 11);
      if (!pattern) break;
      const code = CODE128_PATTERN_TO_VALUE.get(pattern);
      if (code === undefined) break;
      codes.push(code);
      cursor += 6;
      if (codes.length > 64) break;
    }

    if (!foundStop || codes.length < 3) continue;

    const expectedChecksum = codes[codes.length - 1];
    let checksum = codes[0];
    for (let i = 1; i < codes.length - 1; i += 1) {
      checksum += codes[i] * i;
    }
    if (checksum % 103 !== expectedChecksum) continue;

    // Decode data symbols according to active Code 128 subset (B or C)
    let mode: "B" | "C" = codes[0] === START_C ? "C" : "B";
    let output = "";
    let valid = true;
    for (let i = 1; i < codes.length - 1; i += 1) {
      const code = codes[i];
      if (mode === "B") {
        if (code === CODE_C) {
          mode = "C";
        } else if (code >= 0 && code <= 94) {
          output += String.fromCharCode(code + 32);
        } else if (code === 100 || code === 98 || code === 102) {
          // FNC/Control in B: ignore
        } else {
          valid = false;
          break;
        }
      } else {
        if (code === CODE_B) {
          mode = "B";
        } else if (code >= 0 && code <= 99) {
          output += String(code).padStart(2, "0");
        } else {
          valid = false;
          break;
        }
      }
    }

    if (valid && output.trim().length > 0) {
      return output.trim();
    }
  }
  return null;
}

/** Decode an EAN-13 (or UPC-A) barcode from a sequence of alternating bar/space runs. */
export function decodeEan13FromRuns(runs: readonly Run[]): string | null {
  // EAN-13 has: start guard (3 runs: 1-1-1) + 6 left digits (24 runs) + center guard (5 runs: 1-1-1-1-1) + 6 right digits (24 runs) + end guard (3 runs: 1-1-1) = 59 runs.
  for (let start = 0; start <= runs.length - 59; start += 1) {
    if (!runs[start].isBar) continue;
    const startGuard = quantizePattern(runs, start, 3, 3);
    if (startGuard !== "111") continue;
    const centerGuard = quantizePattern(runs, start + 27, 5, 5);
    if (centerGuard !== "11111") continue;
    const endGuard = quantizePattern(runs, start + 56, 3, 3);
    if (endGuard !== "111") continue;

    let parity = "";
    let digits = "";
    let ok = true;

    for (let d = 0; d < 6; d += 1) {
      const pat = quantizePattern(runs, start + 3 + d * 4, 4, 7);
      if (!pat) {
        ok = false;
        break;
      }
      if (EAN_L_CODES.has(pat)) {
        parity += "L";
        digits += String(EAN_L_CODES.get(pat));
      } else if (EAN_G_CODES.has(pat)) {
        parity += "G";
        digits += String(EAN_G_CODES.get(pat));
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const firstDigit = EAN_FIRST_DIGIT_PARITY.get(parity);
    if (firstDigit === undefined) continue;
    digits = String(firstDigit) + digits;

    for (let d = 0; d < 6; d += 1) {
      const pat = quantizePattern(runs, start + 32 + d * 4, 4, 7);
      if (!pat || !EAN_R_CODES.has(pat)) {
        ok = false;
        break;
      }
      digits += String(EAN_R_CODES.get(pat));
    }
    if (!ok || digits.length !== 13) continue;

    // Validate EAN-13 Modulo-10 check digit
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    if (check === Number(digits[12])) {
      return digits;
    }
  }
  return null;
}

/** Extract a binary bar/space row from RGBA image data at `rowY` using adaptive thresholding. */
export function extractBinaryScanlineFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  rowY: number,
): boolean[] {
  const luma = new Float32Array(width);
  let min = 255;
  let max = 0;
  const rowOffset = rowY * width * 4;
  for (let x = 0; x < width; x += 1) {
    const idx = rowOffset + x * 4;
    const y = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    luma[x] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const threshold = (min + max) / 2;
  const binary: boolean[] = new Array(width);
  for (let x = 0; x < width; x += 1) {
    binary[x] = luma[x] < threshold;
  }
  return binary;
}

/** Decode Code 128 or EAN-13 across multiple horizontal scanlines of an RGBA frame. */
export function decode1DBarcodeFromRgbaFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { rawValue: string; format: "code_128" | "ean_13" } | null {
  if (width < 40 || height < 1) return null;
  const sampleFractions = [0.5, 0.4, 0.6, 0.3, 0.7];
  for (const fraction of sampleFractions) {
    const rowY = Math.min(height - 1, Math.max(0, Math.floor(height * fraction)));
    const binary = extractBinaryScanlineFromRgba(rgba, width, rowY);
    const runs = binaryRowToRuns(binary);
    const code128 = decodeCode128FromRuns(runs);
    if (code128) return { rawValue: code128, format: "code_128" };
    const ean13 = decodeEan13FromRuns(runs);
    if (ean13) return { rawValue: ean13, format: "ean_13" };
  }
  return null;
}

/**
 * Decode a video/canvas frame using Native BarcodeDetector first, then falling
 * back to the pure-TS 1D Canvas scanline decoder.
 */
export async function detectBarcodeFromVideoElement(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<{ rawValue: string; format: string; engine: BarcodeDecoderEngine } | null> {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null;
  }

  const ctor = getNativeBarcodeDetectorCtor();
  if (ctor) {
    try {
      const detector = new ctor({ formats: [...TARGET_FORMATS] });
      const results = await detector.detect(video);
      const hit = results.find((item) => typeof item.rawValue === "string" && item.rawValue.trim().length > 0);
      if (hit?.rawValue) {
        return {
          rawValue: hit.rawValue.trim(),
          format: hit.format || "unknown",
          engine: "native-barcode-detector",
        };
      }
    } catch {
      /* fall through to software canvas decoder */
    }
  }

  const width = Math.min(960, video.videoWidth);
  const height = Math.max(120, Math.round((video.videoHeight / video.videoWidth) * width));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const softwareHit = decode1DBarcodeFromRgbaFrame(imageData.data, width, height);
  if (softwareHit) {
    return {
      rawValue: softwareHit.rawValue,
      format: softwareHit.format,
      engine: "software-canvas-1d",
    };
  }
  return null;
}
