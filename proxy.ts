import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/token";

const COOKIE = process.env.NODE_ENV === "production" ? "__Host-sas_session" : "sas_session";

function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.supabase.co",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function toLogin(request: NextRequest, path = "/login"): NextResponse {
  const url = new URL(path, request.url);
  if (path === "/login") url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

/**
 * Primera barrera: CSP con nonce por petición, id de petición y redirección de
 * rutas privadas cuando no hay una sesión firmada válida. NO es la autorización:
 * cada página y acción vuelve a validar sesión y permisos contra la BD.
 */
export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const path = request.nextUrl.pathname;

  if (path.startsWith("/app") || path.startsWith("/admin")) {
    const claims = await verifySession(request.cookies.get(COOKIE)?.value);
    if (!claims) return toLogin(request);
    if (!claims.mfa && claims.tid === null) return toLogin(request, "/login/mfa");
    // Sesión de tenant (o soporte en curso) en /admin: de vuelta a su panel.
    if (path.startsWith("/admin") && claims.tid !== null) {
      return NextResponse.redirect(new URL("/app", request.url));
    }
    if (path.startsWith("/app") && claims.tid === null)
      return NextResponse.redirect(new URL("/admin", request.url));
  }

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("x-request-id", requestId);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|api/inngest).*)" }],
};
