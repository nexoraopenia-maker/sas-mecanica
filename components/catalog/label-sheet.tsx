import { BarcodeSvg } from "@/components/catalog/barcode-svg";
import { expandLabels, LABEL_FORMATS, labelName, type LabelFormatId } from "@/lib/catalog/labels";
import type { LabelProduct } from "@/server/services/catalog";

/**
 * Hoja de etiquetas. En pantalla se ve como vista previa; al imprimir, `@page` fija el tamaño exacto de la
 * etiqueta (una por página, sin márgenes) y solo se imprime esta hoja. La etiqueta es blanca a propósito:
 * el lector óptico necesita contraste, no el tema oscuro.
 */
export function LabelSheet({
  products,
  copies,
  format,
}: {
  products: LabelProduct[];
  copies: number;
  format: LabelFormatId;
}) {
  const spec = LABEL_FORMATS[format];
  const labels = expandLabels(products, copies);
  return (
    <>
      <style>{`
        @page { size: ${spec.widthMm}mm ${spec.heightMm}mm; margin: 0; }
        @media print {
          body * { visibility: hidden !important; }
          .label-sheet, .label-sheet * { visibility: visible !important; }
          .label-sheet { position: absolute; left: 0; top: 0; display: block !important; gap: 0 !important; }
          .label { break-after: page; page-break-after: always; border: 0 !important; }
        }
      `}</style>
      <div
        className="label-sheet flex flex-wrap gap-3"
        data-testid="label-sheet"
        data-count={labels.length}
      >
        {labels.map((product, index) => (
          <div
            key={`${product.id}-${index}`}
            data-testid="label"
            className="label flex flex-col justify-between overflow-hidden border border-dashed border-border bg-paper p-[1.2mm] text-ink"
            style={{ width: `${spec.widthMm}mm`, height: `${spec.heightMm}mm` }}
          >
            <p className="text-[7pt] font-semibold leading-tight">{labelName(product.name)}</p>
            <div className="flex items-baseline justify-between gap-1 leading-none">
              <span className="truncate text-[6pt]">{product.sku}</span>
              <span className="text-[9pt] font-bold">
                S/ {Number(product.salePrice).toFixed(2)}
              </span>
            </div>
            <BarcodeSvg value={product.barcode} height={spec.barHeight} className="w-full" />
            <p className="text-center font-mono text-[6pt] leading-none tracking-widest">
              {product.barcode}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
