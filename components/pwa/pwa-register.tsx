"use client";

import { useEffect } from "react";

/** Registra el service worker (solo en producción: en desarrollo la caché estorbaría). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}

/** Pide al service worker borrar las páginas guardadas (al cerrar sesión o cambiar de usuario). */
export async function clearPrivateCaches(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.active?.postMessage({ type: "CLEAR_PRIVATE_CACHES" });
}
