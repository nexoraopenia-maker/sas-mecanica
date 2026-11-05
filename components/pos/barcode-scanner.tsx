"use client";

import { Camera, FlashlightOff, Flashlight, SwitchCamera, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { es } from "@/lib/i18n/es";
import { ScanDebouncer } from "@/lib/pos/scan";
import { createDetector, type CodeDetector } from "@/lib/pos/scanner-engine";

export type ScanResult =
  { kind: "added"; label: string } | { kind: "not_found"; code: string } | { kind: "ignored" };

const FRAME_INTERVAL_MS = 140;

function cameraError(error: unknown): string {
  const t = es.scanner;
  if (!window.isSecureContext) return t.insecure;
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t.denied;
  if (name === "NotFoundError" || name === "OverconstrainedError") return t.noCamera;
  if (name === "NotReadableError") return t.busy;
  return t.generic;
}

/** Pitido corto con WebAudio (sin archivos de sonido): agudo = leído, grave = no encontrado. */
function beep(frequency: number): void {
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const audio = new AudioCtx();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.12);
    oscillator.onended = () => void audio.close();
  } catch {
    // Sin audio disponible: solo se omite el pitido.
  }
}

/**
 * Escáner con la cámara (celular, tablet o laptop) para códigos de barras y QR. Se abre como diálogo modal,
 * lee de forma continua y avisa con pitido/vibración. «Seguir escaneando» permite pasar varios productos sin
 * volver a abrirlo.
 */
export function BarcodeScanner({
  open,
  onClose,
  onCode,
}: {
  open: boolean;
  onClose: () => void;
  onCode: (raw: string) => Promise<ScanResult>;
}) {
  const t = es.scanner;
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const debouncer = useRef(new ScanDebouncer(1200));
  const onCodeRef = useRef(onCode);
  const onCloseRef = useRef(onClose);
  const continuousRef = useRef(true);
  const [status, setStatus] = useState<string>(t.starting);
  const [error, setError] = useState<string | null>(null);
  const [continuous, setContinuous] = useState(true);
  const [torch, setTorch] = useState<{ available: boolean; on: boolean }>({
    available: false,
    on: false,
  });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);

  // Los manejadores del padre cambian en cada pintado: se guardan en refs para no reiniciar la cámara.
  useEffect(() => {
    onCodeRef.current = onCode;
    onCloseRef.current = onClose;
  }, [onCode, onClose]);
  useEffect(() => {
    continuousRef.current = continuous;
  }, [continuous]);

  // Abre y cierra el <dialog> nativo (trampa de foco y Escape incluidos).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Cámara + bucle de lectura mientras el diálogo está abierto.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let frame = 0;
    let detector: CodeDetector | null = null;
    let busy = false;
    let last = 0;
    debouncer.current.reset();
    /* eslint-disable react-hooks/set-state-in-effect */
    setError(null);
    setStatus(t.starting);
    /* eslint-enable react-hooks/set-state-in-effect */

    const loop = (now: number) => {
      if (cancelled) return;
      frame = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video || !detector || busy || now - last < FRAME_INTERVAL_MS || video.readyState < 2)
        return;
      busy = true;
      last = now;
      detector
        .detect(video)
        .then(async (codes) => {
          for (const code of codes) {
            if (cancelled || !debouncer.current.accept(code)) continue;
            const result = await onCodeRef.current(code);
            if (result.kind === "added") {
              beep(880);
              navigator.vibrate?.(60);
              setStatus(`${t.added}: ${result.label}`);
              if (!continuousRef.current) onCloseRef.current();
            } else if (result.kind === "not_found") {
              beep(220);
              setStatus(t.notFound(result.code));
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new DOMException("sin API", "NotFoundError");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        const track = stream.getVideoTracks()[0];
        const capabilities = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorch({ available: Boolean(capabilities.torch), on: false });
        setDevices(
          (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"),
        );
        detector = await createDetector();
        if (cancelled) return;
        setEngine(detector.engine);
        setStatus(t.aim);
        frame = requestAnimationFrame(loop);
      } catch (cause) {
        if (!cancelled) setError(cameraError(cause));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stop();
    };
  }, [open, deviceId, stop, t]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch({ available: true, on: next });
    } catch {
      setTorch({ available: false, on: false });
    }
  }

  function nextCamera() {
    if (devices.length < 2) return;
    const index = devices.findIndex(
      (d) =>
        d.deviceId === (deviceId ?? streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId),
    );
    setDeviceId(devices[(index + 1) % devices.length]?.deviceId ?? null);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(100vw-1rem,34rem)] rounded-xl border border-border bg-popover p-0 text-foreground shadow-glass backdrop:bg-background/80"
      data-testid="scanner-dialog"
    >
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
            <Camera className="size-5" aria-hidden />
            {t.title}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t.close}
            onClick={onClose}
            autoFocus
          >
            <X />
          </Button>
        </div>

        <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-border bg-background">
          <video
            ref={videoRef}
            muted
            playsInline
            className="size-full object-cover"
            data-testid="scanner-video"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-[12%] rounded-lg border-2 border-dashed border-primary/80"
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
            data-testid="scanner-error"
          >
            {error}
          </p>
        ) : (
          <p
            role="status"
            aria-live="polite"
            className="min-h-6 text-sm text-muted-foreground"
            data-testid="scanner-status"
          >
            {status}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={continuous}
              onChange={(event) => setContinuous(event.target.checked)}
            />
            {t.continuous}
          </label>
          <div className="flex gap-2">
            {torch.available ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t.torch}
                aria-pressed={torch.on}
                onClick={() => void toggleTorch()}
              >
                {torch.on ? <FlashlightOff /> : <Flashlight />}
              </Button>
            ) : null}
            {devices.length > 1 ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t.switchCamera}
                onClick={nextCamera}
              >
                <SwitchCamera />
              </Button>
            ) : null}
          </div>
        </div>
        {engine ? <p className="sr-only">{t.engine(engine)}</p> : null}
      </div>
    </dialog>
  );
}
