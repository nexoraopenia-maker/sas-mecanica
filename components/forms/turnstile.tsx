"use client";

import Script from "next/script";

/** Captcha de Cloudflare Turnstile. Sin clave de sitio (solo desarrollo) no se muestra. */
export function Turnstile({ siteKey, nonce }: { siteKey: string | undefined; nonce?: string }) {
  if (!siteKey) return null;
  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="afterInteractive"
        nonce={nonce}
      />
      <div className="cf-turnstile" data-sitekey={siteKey} />
    </>
  );
}
