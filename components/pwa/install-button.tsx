"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { es } from "@/lib/i18n/es";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * «Instalar app»: en Chrome/Edge/Android usa el aviso nativo; en iPhone/iPad (que no lo tiene) muestra cómo
 * agregarla a la pantalla de inicio. Desaparece cuando la app ya está instalada.
 */
export function InstallButton() {
  const t = es.pwa;
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(true);

  useEffect(() => {
    // Todo esto depende de APIs del navegador: se resuelve después de montar.
    /* eslint-disable react-hooks/set-state-in-effect */
    setInstalled(isStandalone());
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    /* eslint-enable react-hooks/set-state-in-effect */
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;
  if (prompt)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        data-testid="pwa-install"
        onClick={async () => {
          await prompt.prompt();
          await prompt.userChoice;
          setPrompt(null);
        }}
      >
        <Download aria-hidden />
        {t.install}
      </Button>
    );
  if (ios)
    return (
      <p className="px-3 text-xs text-muted-foreground" data-testid="pwa-ios-hint">
        {t.iosHint}
      </p>
    );
  return null;
}
