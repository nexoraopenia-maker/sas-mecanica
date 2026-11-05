"use client";

import { Camera } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BarcodeScanner, type ScanResult } from "@/components/pos/barcode-scanner";
import { useOffline } from "@/components/offline/offline-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";
import { fetchSuggestions, mergeProducts } from "@/lib/pos/pos-fetch";
import { highlightParts, normalizeText } from "@/lib/pos/search";
import { matchScan, scanCandidates } from "@/lib/pos/scan";
import type { PosProduct } from "@/lib/pos/types";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 120;
const MIN_CHARS = 2;

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-sm bg-primary/25 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Buscador predictivo del mostrador. Responde al instante con el catálogo guardado en el dispositivo y,
 * con conexión, completa con el servidor (nuevos productos y stock actual) sin bloquear la escritura.
 * Teclado: ↑/↓ elige, Enter agrega, Esc cierra. Un lector de código termina en Enter y entra directo.
 */
export function ProductSearch({
  onPick,
  inputRef,
}: {
  onPick: (product: PosProduct) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const t = es.pos;
  const offline = useOffline();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [remote, setRemote] = useState<{ query: string; products: PosProduct[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmed = query.trim();
  const local = useMemo(
    () => (trimmed.length >= MIN_CHARS ? offline.searchLocal(trimmed, 8) : []),
    [offline, trimmed],
  );
  const suggestions = useMemo(
    () =>
      trimmed.length < MIN_CHARS
        ? []
        : mergeProducts(local, remote && remote.query === trimmed ? remote.products : [], 8),
    [local, remote, trimmed],
  );

  // Consulta al servidor con espera mínima y cancelando la anterior (nunca llegan respuestas viejas).
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    abort.current?.abort();
    if (trimmed.length < MIN_CHARS || !offline.online) return;
    timer.current = setTimeout(() => {
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      fetchSuggestions(trimmed, controller.signal)
        .then((products) => {
          setRemote({ query: trimmed, products });
          setNotice(null);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Sin respuesta del servidor: se sigue con el catálogo del dispositivo.
          setNotice(local.length === 0 ? "No se pudo consultar el servidor." : null);
        })
        .finally(() => {
          if (abort.current === controller) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, [trimmed, offline.online]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(product: PosProduct) {
    onPick(product);
    setAdded(product.name);
    setQuery("");
    setOpen(false);
    setActive(-1);
    setRemote(null);
    setNotice(null);
    inputRef.current?.focus();
  }

  /** Código leído con la cámara: coincidencia exacta de SKU, código de barras u OEM (primero en el dispositivo, luego en el servidor). */
  const resolveScan = useCallback(
    async (raw: string): Promise<ScanResult> => {
      const candidates = scanCandidates(raw);
      if (candidates.length === 0) return { kind: "ignored" };
      let product = offline.catalog ? matchScan(offline.catalog.products, candidates) : null;
      if (!product && offline.online) {
        for (const candidate of candidates.slice(0, 3)) {
          try {
            product = matchScan(await fetchSuggestions(candidate), candidates);
          } catch {
            break;
          }
          if (product) break;
        }
      }
      if (!product) return { kind: "not_found", code: candidates[0] ?? raw };
      onPick(product);
      setAdded(product.name);
      return { kind: "added", label: product.name };
    },
    [offline.catalog, offline.online, onPick],
  );

  /** Enter: elige la sugerencia marcada o una coincidencia exacta de SKU/código (flujo del lector de barras). */
  async function submit() {
    if (trimmed.length === 0) return;
    if (active >= 0 && suggestions[active]) return pick(suggestions[active]);
    const whole = normalizeText(trimmed);
    const exact = (list: readonly PosProduct[]) =>
      list.filter(
        (p) => normalizeText(p.sku) === whole || (p.barcode && normalizeText(p.barcode) === whole),
      );
    const local1 = exact(suggestions);
    if (local1.length === 1 && local1[0]) return pick(local1[0]);
    let candidates = suggestions;
    if (offline.online) {
      try {
        candidates = mergeProducts(suggestions, await fetchSuggestions(trimmed), 8);
      } catch {
        // Se decide con lo que hay en el dispositivo.
      }
    }
    const found = exact(candidates);
    if (found.length === 1 && found[0]) return pick(found[0]);
    if (candidates.length === 1 && candidates[0]) return pick(candidates[0]);
    setRemote({ query: trimmed, products: candidates });
    setOpen(true);
    if (candidates.length === 0) setNotice(t.noResults);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  const showList = open && trimmed.length >= MIN_CHARS;

  return (
    <div className="relative">
      <Label htmlFor="scan">{t.scan}</Label>
      <div className="flex gap-2">
        <Input
          id="scan"
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
            setNotice(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={t.scanHelp}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={es.scanner.open}
          title={es.scanner.open}
          onClick={() => setScanning(true)}
          data-testid="scan-camera"
        >
          <Camera />
        </Button>
      </div>
      <BarcodeScanner open={scanning} onClose={() => setScanning(false)} onCode={resolveScan} />
      <p className="sr-only" role="status" aria-live="polite">
        {added ? `${t.added}: ${added}` : ""}
      </p>
      {showList ? (
        <div
          className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-border bg-popover shadow-glass"
          data-testid="pos-suggestions"
        >
          {suggestions.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={t.results}
              className="max-h-80 overflow-y-auto overscroll-contain py-1"
            >
              {suggestions.map((product, index) => (
                <li
                  key={product.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-testid="pos-suggestion"
                  // `mousedown` evita que el campo pierda el foco antes de registrar el clic.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(product);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-center justify-between gap-3 px-3 py-2",
                    index === active ? "bg-primary/15" : "hover:bg-muted",
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      <Highlight text={product.name} query={trimmed} />
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      <Highlight text={product.sku} query={trimmed} />
                      {product.brand ? ` · ${product.brand}` : ""}
                      {product.tire ? ` · ${product.tire}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold">S/ {Number(product.salePrice).toFixed(2)}</p>
                    {product.isStocked && product.stock !== null ? (
                      <p
                        className={cn(
                          "text-xs",
                          product.stock <= 0 ? "text-danger" : "text-muted-foreground",
                        )}
                      >
                        {product.stock <= 0 ? t.noStock : `${t.stock} ${product.stock}`}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-muted-foreground" role="status">
              {loading ? t.searching : (notice ?? t.noResults)}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span>
              {loading ? t.searching : offline.online ? t.suggestionsHint : t.offlineCatalog}
            </span>
            <span aria-hidden>↑↓ · Enter · Esc</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
