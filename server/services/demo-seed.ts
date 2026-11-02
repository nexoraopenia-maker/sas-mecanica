import type { Prisma, ProductKind, TenantTx, TrackingMode, WorkOrderStatus } from "@/lib/db";
import { nextSequence } from "@/lib/db";

export interface DemoSeedContext {
  warehouseId: string;
  branchId: string;
  mechanicId: string;
  adminId: string;
}

interface ProductSpec {
  sku: string;
  name: string;
  kind: ProductKind;
  brand: string;
  price: string;
  cost: string;
  qty: number;
  min: number;
  reorder: number;
  tracking?: TrackingMode;
  warranty?: "battery" | "tire" | "brakes";
  barcode?: string;
  /** Llantas: lotes con DOT (semana+año). */
  lots?: Array<{ dot: string; qty: number }>;
  tire?: {
    width: number;
    ratio: number;
    rim: number;
    load: number;
    speed: string;
    design: string;
    rack: string;
  };
  battery?: { ah: number; cca: number; polarity: "LEFT_POSITIVE" | "RIGHT_POSITIVE" };
  lubricant?: {
    viscosity: string;
    base: "MINERAL" | "SEMI_SYNTHETIC" | "SYNTHETIC";
    liters: string;
    api: string;
  };
  part?: { oem?: string; isOem: boolean; category: string; position?: string };
  compat?: Array<{ make: string; model: string; from: number; to: number; engine?: string }>;
  stocked?: boolean;
}

const tire = (
  sku: string,
  brand: string,
  design: string,
  w: number,
  r: number,
  rim: number,
  load: number,
  speed: string,
  price: string,
  cost: string,
  qty: number,
  min: number,
  reorder: number,
  lots: ProductSpec["lots"],
): ProductSpec => ({
  sku,
  name: `Llanta ${w}/${r} R${rim} ${brand} ${design}`,
  kind: "TIRE",
  brand,
  price,
  cost,
  qty,
  min,
  reorder,
  tracking: "LOT",
  warranty: "tire",
  lots,
  tire: { width: w, ratio: r, rim, load, speed, design, rack: `R${(qty % 5) + 1}-N${(w % 3) + 1}` },
});
const battery = (
  sku: string,
  brand: string,
  ah: number,
  cca: number,
  price: string,
  cost: string,
  qty: number,
  min: number,
  reorder: number,
  polarity: "LEFT_POSITIVE" | "RIGHT_POSITIVE" = "LEFT_POSITIVE",
): ProductSpec => ({
  sku,
  name: `Batería 12V ${ah}Ah ${cca}CCA ${brand}`,
  kind: "BATTERY",
  brand,
  price,
  cost,
  qty,
  min,
  reorder,
  tracking: "SERIAL",
  warranty: "battery",
  battery: { ah, cca, polarity },
});
const oil = (
  sku: string,
  brand: string,
  viscosity: string,
  base: "MINERAL" | "SEMI_SYNTHETIC" | "SYNTHETIC",
  liters: string,
  price: string,
  cost: string,
  qty: number,
  min: number,
  reorder: number,
): ProductSpec => ({
  sku,
  name: `Aceite ${viscosity} ${base === "SYNTHETIC" ? "sintético" : base === "MINERAL" ? "mineral" : "semisintético"} ${brand} ${liters}L`,
  kind: "LUBRICANT",
  brand,
  price,
  cost,
  qty,
  min,
  reorder,
  lubricant: { viscosity, base, liters, api: "SN" },
});
const part = (
  sku: string,
  name: string,
  brand: string,
  oem: string | undefined,
  isOem: boolean,
  category: string,
  price: string,
  cost: string,
  qty: number,
  min: number,
  reorder: number,
  extra: Partial<ProductSpec> = {},
): ProductSpec => ({
  sku,
  name,
  kind: "PART",
  brand,
  price,
  cost,
  qty,
  min,
  reorder,
  part: { ...(oem ? { oem } : {}), isOem, category },
  ...extra,
});
const service = (sku: string, name: string, price: string): ProductSpec => ({
  sku,
  name,
  kind: "SERVICE",
  brand: "Taller",
  price,
  cost: "0",
  qty: 0,
  min: 0,
  reorder: 0,
  stocked: false,
});

/**
 * Catálogo realista: 36 productos (33 con stock + 3 servicios). Cinco quedan en
 * stock CRÍTICO (marcados abajo) y tres en punto de reorden.
 */
export const DEMO_PRODUCTS: ProductSpec[] = [
  // Llantas (la 205/55 R16 Michelin está en estado CRÍTICO)
  tire(
    "LL-2055516-MICH",
    "Michelin",
    "Primacy 4",
    205,
    55,
    16,
    91,
    "V",
    "389.00",
    "290.00",
    2,
    8,
    12,
    [{ dot: "2425", qty: 2 }],
  ),
  tire(
    "LL-2055516-BRID",
    "Bridgestone",
    "Turanza T005",
    205,
    55,
    16,
    91,
    "V",
    "365.00",
    "272.00",
    20,
    8,
    12,
    [
      { dot: "1925", qty: 12 },
      { dot: "3024", qty: 8 },
    ],
  ),
  // DOT 1218: llanta de más de 5 años (dispara la alerta de llantas antiguas).
  tire(
    "LL-2055516-PIRE",
    "Pirelli",
    "Cinturato P1",
    205,
    55,
    16,
    91,
    "H",
    "339.00",
    "251.00",
    10,
    6,
    9,
    [
      { dot: "1218", qty: 4 },
      { dot: "0825", qty: 6 },
    ],
  ),
  tire(
    "LL-2055516-GOOD",
    "Goodyear",
    "EfficientGrip",
    205,
    55,
    16,
    91,
    "V",
    "349.00",
    "259.00",
    16,
    6,
    9,
    [{ dot: "2125", qty: 16 }],
  ),
  tire(
    "LL-1956515-MICH",
    "Michelin",
    "Energy XM2",
    195,
    65,
    15,
    91,
    "H",
    "329.00",
    "241.00",
    14,
    6,
    9,
    [{ dot: "1725", qty: 14 }],
  ),
  tire(
    "LL-1856514-BRID",
    "Bridgestone",
    "Ecopia EP150",
    185,
    65,
    14,
    86,
    "H",
    "249.00",
    "181.00",
    12,
    6,
    9,
    [{ dot: "2025", qty: 12 }],
  ),
  tire("LL-2254517-PIRE", "Pirelli", "P Zero", 225, 45, 17, 94, "W", "589.00", "439.00", 8, 4, 6, [
    { dot: "1525", qty: 8 },
  ]),
  tire(
    "LL-2656517-DUNL",
    "Dunlop",
    "Grandtrek AT20",
    265,
    65,
    17,
    112,
    "S",
    "649.00",
    "479.00",
    8,
    4,
    6,
    [{ dot: "2225", qty: 8 }],
  ),
  tire(
    "LL-1757013-YOKO",
    "Yokohama",
    "BluEarth",
    175,
    70,
    13,
    82,
    "T",
    "189.00",
    "136.00",
    18,
    8,
    12,
    [{ dot: "1625", qty: 18 }],
  ),
  tire(
    "LL-2156016-CONT",
    "Continental",
    "ComfortContact",
    215,
    60,
    16,
    95,
    "V",
    "379.00",
    "281.00",
    10,
    4,
    6,
    [{ dot: "1425", qty: 10 }],
  ),
  // Baterías con número de serie (la Bosch 12V 60Ah 550CCA está en estado CRÍTICO)
  battery("BAT-12V60-BOSCH", "Bosch S4", 60, 550, "389.00", "295.00", 1, 4, 6),
  battery("BAT-12V60-ETNA", "Etna", 60, 550, "359.00", "268.00", 6, 3, 5),
  battery("BAT-12V60-WILL", "Willard", 60, 550, "349.00", "259.00", 5, 3, 5),
  battery("BAT-12V45-BOSCH", "Bosch S3", 45, 400, "299.00", "219.00", 5, 3, 5),
  battery("BAT-12V75-ETNA", "Etna", 75, 650, "459.00", "345.00", 4, 2, 4, "RIGHT_POSITIVE"),
  // Lubricantes (el Mobil 1 5W-30 está en estado CRÍTICO)
  oil("LU-5W30-MOBIL", "Mobil 1", "5W-30", "SYNTHETIC", "4", "189.00", "139.00", 3, 12, 18),
  oil("LU-5W30-CAST", "Castrol Edge", "5W-30", "SYNTHETIC", "4", "179.00", "131.00", 30, 12, 18),
  oil(
    "LU-10W40-SHELL",
    "Shell Helix",
    "10W-40",
    "SEMI_SYNTHETIC",
    "4",
    "139.00",
    "101.00",
    26,
    10,
    15,
  ),
  oil("LU-5W40-TOTAL", "Total Quartz", "5W-40", "SYNTHETIC", "4", "169.00", "123.00", 22, 8, 12),
  oil("LU-20W50-VALV", "Valvoline", "20W-50", "MINERAL", "1", "32.00", "22.00", 40, 15, 22),
  oil("LU-ATF-DEXVI", "Dexron VI", "ATF", "SYNTHETIC", "1", "45.00", "32.00", 10, 8, 12),
  // Repuestos (pastillas Toyota OEM y filtro de aceite Toyota en estado CRÍTICO)
  part(
    "FR-PAST-YARIS-OEM",
    "Pastillas de freno delanteras Toyota Yaris (OEM)",
    "Toyota",
    "04465-52130",
    true,
    "Frenos",
    "189.00",
    "128.00",
    1,
    6,
    9,
    {
      warranty: "brakes",
      compat: [{ make: "Toyota", model: "Yaris", from: 2014, to: 2020, engine: "1.3L" }],
    },
  ),
  part(
    "FR-PAST-ACCENT-BOSCH",
    "Pastillas de freno delanteras Bosch Hyundai Accent",
    "Bosch",
    "58101-1RA00",
    false,
    "Frenos",
    "129.00",
    "86.00",
    12,
    5,
    8,
    { warranty: "brakes", compat: [{ make: "Hyundai", model: "Accent", from: 2012, to: 2019 }] },
  ),
  part(
    "FR-PAST-SENTRA-TRAS",
    "Pastillas de freno traseras Nissan Sentra",
    "TRW",
    "44060-3SH0A",
    false,
    "Frenos",
    "119.00",
    "79.00",
    9,
    4,
    6,
    { warranty: "brakes", compat: [{ make: "Nissan", model: "Sentra", from: 2013, to: 2020 }] },
  ),
  part(
    "FR-DISCO-SAIL",
    "Disco de freno delantero Chevrolet Sail",
    "Brembo",
    undefined,
    false,
    "Frenos",
    "169.00",
    "118.00",
    8,
    4,
    6,
    { compat: [{ make: "Chevrolet", model: "Sail", from: 2013, to: 2021 }] },
  ),
  part(
    "FI-ACEITE-TOYOTA",
    "Filtro de aceite Toyota (OEM)",
    "Toyota",
    "90915-YZZE1",
    true,
    "Filtros",
    "39.00",
    "24.00",
    2,
    10,
    15,
    {
      compat: [
        { make: "Toyota", model: "Yaris", from: 2010, to: 2022 },
        { make: "Toyota", model: "Corolla", from: 2010, to: 2022 },
      ],
    },
  ),
  part(
    "FI-AIRE-KN",
    "Filtro de aire K&N",
    "K&N",
    "33-2304",
    false,
    "Filtros",
    "149.00",
    "105.00",
    9,
    4,
    6,
  ),
  part(
    "FI-COMB-BOSCH",
    "Filtro de combustible Bosch",
    "Bosch",
    "0450905320",
    false,
    "Filtros",
    "59.00",
    "39.00",
    8,
    6,
    9,
  ),
  part(
    "EN-BUJIA-NGK",
    "Bujía NGK Iridium",
    "NGK",
    "ILKAR7B11",
    false,
    "Encendido",
    "42.00",
    "28.00",
    36,
    16,
    24,
  ),
  part(
    "EN-FAJA-GATES",
    "Faja de distribución Gates",
    "Gates",
    "T295",
    false,
    "Motor",
    "129.00",
    "88.00",
    7,
    3,
    5,
  ),
  part(
    "LI-FRENOS-DOT4",
    "Líquido de frenos DOT4 500ml",
    "Bosch",
    undefined,
    false,
    "Líquidos",
    "22.00",
    "14.00",
    32,
    12,
    18,
  ),
  part(
    "LI-REFRIG-50",
    "Refrigerante 50/50 1 galón",
    "Prestone",
    undefined,
    false,
    "Líquidos",
    "49.00",
    "33.00",
    20,
    8,
    12,
  ),
  part(
    "SU-AMORT-RIO",
    "Amortiguador delantero Monroe Kia Rio",
    "Monroe",
    "54650-1G500",
    false,
    "Suspensión",
    "239.00",
    "172.00",
    6,
    2,
    4,
    { compat: [{ make: "Kia", model: "Rio", from: 2012, to: 2022 }] },
  ),
  // Servicios (mano de obra, no llevan stock)
  service("SV-CAMBIO-ACEITE", "Mano de obra: cambio de aceite y filtro", "40.00"),
  service("SV-ALINEAMIENTO", "Alineamiento y balanceo (4 llantas)", "90.00"),
  service("SV-DIAGNOSTICO", "Diagnóstico computarizado", "60.00"),
];

const CRITICAL_SKUS = [
  "LL-2055516-MICH",
  "BAT-12V60-BOSCH",
  "LU-5W30-MOBIL",
  "FR-PAST-YARIS-OEM",
  "FI-ACEITE-TOYOTA",
];
export const DEMO_CRITICAL_SKUS: readonly string[] = CRITICAL_SKUS;

function dotToDate(dot: string): Date {
  const week = Number(dot.slice(0, 2));
  const year = 2000 + Number(dot.slice(2, 4));
  return new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
}

type Tx = TenantTx;

async function seedCatalog(tx: Tx) {
  const category = new Map<string, string>();
  for (const name of [
    "Llantas",
    "Baterías",
    "Lubricantes",
    "Frenos",
    "Filtros",
    "Motor y encendido",
    "Líquidos",
    "Suspensión",
    "Servicios",
  ]) {
    category.set(name, (await tx.productCategory.create({ data: { name } })).id);
  }
  const categoryFor = (spec: ProductSpec): string | undefined =>
    category.get(
      spec.kind === "TIRE"
        ? "Llantas"
        : spec.kind === "BATTERY"
          ? "Baterías"
          : spec.kind === "LUBRICANT"
            ? "Lubricantes"
            : spec.kind === "SERVICE"
              ? "Servicios"
              : spec.part?.category === "Frenos"
                ? "Frenos"
                : spec.part?.category === "Filtros"
                  ? "Filtros"
                  : spec.part?.category === "Líquidos"
                    ? "Líquidos"
                    : spec.part?.category === "Suspensión"
                      ? "Suspensión"
                      : "Motor y encendido",
    );

  const policies = {
    battery: (
      await tx.warrantyPolicy.create({
        data: {
          name: "Batería: 12 meses",
          months: 12,
          coversLabor: false,
          terms: "Cubre defectos de fabricación. Requiere número de serie.",
        },
      })
    ).id,
    tire: (
      await tx.warrantyPolicy.create({
        data: {
          name: "Llanta: 6 meses por defecto de fábrica",
          months: 6,
          terms: "No cubre daños por golpes ni mala presión.",
        },
      })
    ).id,
    brakes: (
      await tx.warrantyPolicy.create({
        data: { name: "Frenos: 3 meses o 5000 km", months: 3, kilometers: 5000, coversLabor: true },
      })
    ).id,
  };

  const ids = new Map<string, string>();
  for (const [index, spec] of DEMO_PRODUCTS.entries()) {
    const product = await tx.product.create({
      data: {
        sku: spec.sku,
        barcode: `775${String(index + 1).padStart(10, "0")}`,
        name: spec.name,
        kind: spec.kind,
        brand: spec.brand,
        categoryId: categoryFor(spec) ?? null,
        trackingMode: spec.tracking ?? "NONE",
        isStocked: spec.stocked !== false,
        salePrice: spec.price,
        lastPurchaseCost: spec.kind === "SERVICE" ? null : spec.cost,
        warrantyPolicyId: spec.warranty ? policies[spec.warranty] : null,
        ...(spec.tire
          ? {
              tireDetail: {
                create: {
                  width: spec.tire.width,
                  aspectRatio: spec.tire.ratio,
                  rimDiameter: spec.tire.rim.toString(),
                  loadIndex: spec.tire.load,
                  speedRating: spec.tire.speed,
                  design: spec.tire.design,
                  rackLocation: spec.tire.rack,
                },
              },
            }
          : {}),
        ...(spec.battery
          ? {
              batteryDetail: {
                create: {
                  capacityAh: spec.battery.ah,
                  ccaA: spec.battery.cca,
                  polarity: spec.battery.polarity,
                  voltage: 12,
                },
              },
            }
          : {}),
        ...(spec.lubricant
          ? {
              lubricantDetail: {
                create: {
                  viscosity: spec.lubricant.viscosity,
                  baseType: spec.lubricant.base,
                  volumeLiters: spec.lubricant.liters,
                  apiSpec: spec.lubricant.api,
                },
              },
            }
          : {}),
        ...(spec.part
          ? {
              partDetail: {
                create: {
                  oemCode: spec.part.oem ?? null,
                  isOem: spec.part.isOem,
                  partCategory: spec.part.category,
                },
              },
            }
          : {}),
        ...(spec.compat
          ? {
              compatibilities: {
                create: spec.compat.map((c) => ({
                  make: c.make,
                  model: c.model,
                  yearFrom: c.from,
                  yearTo: c.to,
                  engine: c.engine ?? null,
                })),
              },
            }
          : {}),
      },
    });
    ids.set(spec.sku, product.id);
  }
  await tx.partEquivalence.createMany({
    data: [
      {
        productId: ids.get("FR-PAST-YARIS-OEM") ?? "",
        code: "04465-0D150",
        brand: "Toyota",
        type: "OEM" as const,
      },
      {
        productId: ids.get("FR-PAST-YARIS-OEM") ?? "",
        code: "GDB3469",
        brand: "TRW",
        type: "ALTERNATIVE" as const,
      },
      {
        productId: ids.get("FI-ACEITE-TOYOTA") ?? "",
        code: "W 68/3",
        brand: "Mann",
        type: "ALTERNATIVE" as const,
      },
    ],
  });
  return ids;
}

async function seedStock(tx: Tx, ctx: DemoSeedContext, ids: Map<string, string>) {
  const movements: Prisma.KardexMovementCreateManyInput[] = [];
  let counter = 0;
  const base = (
    productId: string,
    qty: number,
    cost: string,
    extra: Partial<Prisma.KardexMovementCreateManyInput> = {},
  ) => {
    counter += 1;
    movements.push({
      warehouseId: ctx.warehouseId,
      productId,
      type: "INITIAL",
      quantityDelta: qty.toString(),
      unitCost: cost,
      reason: "Inventario inicial de la demo",
      idempotencyKey: `demo-initial-${counter}`,
      createdById: ctx.adminId,
      ...extra,
    });
  };

  for (const spec of DEMO_PRODUCTS) {
    if (spec.stocked === false) continue;
    const productId = ids.get(spec.sku);
    if (!productId) continue;
    await tx.reorderPolicy.create({
      data: {
        warehouseId: ctx.warehouseId,
        productId,
        mode: "MANUAL",
        manualMinStock: spec.min.toString(),
        manualReorderPoint: spec.reorder.toString(),
      },
    });
    if (spec.lots) {
      for (const lotSpec of spec.lots) {
        const lot = await tx.stockLot.create({
          data: {
            productId,
            code: `DOT-${lotSpec.dot}`,
            dotCode: lotSpec.dot,
            manufacturedAt: dotToDate(lotSpec.dot),
            unitCost: spec.cost,
          },
        });
        base(productId, lotSpec.qty, spec.cost, { lotId: lot.id });
      }
    } else if (spec.tracking === "SERIAL") {
      const serials = await tx.serialNumber.createManyAndReturn({
        data: Array.from({ length: spec.qty }, (_, i) => ({
          productId,
          warehouseId: ctx.warehouseId,
          serial: `${spec.sku.slice(4)}-${String(i + 1).padStart(4, "0")}`,
        })),
      });
      for (const serial of serials) base(productId, 1, spec.cost, { serialId: serial.id });
    } else {
      base(productId, spec.qty, spec.cost);
    }
  }
  await tx.kardexMovement.createMany({ data: movements });
}

async function seedSuppliers(tx: Tx, ids: Map<string, string>) {
  const defs = [
    {
      name: "Distribuidora Andina de Llantas SAC",
      taxId: "20512345671",
      lead: 3,
      whitelisted: true,
      whatsapp: "+51987000001",
      email: "ventas@andinallantas.example",
      terms: "Crédito 15 días",
    },
    {
      name: "Baterías y Lubricantes del Sur EIRL",
      taxId: "20487654322",
      lead: 2,
      whitelisted: true,
      whatsapp: "+51987000002",
      email: "pedidos@bateriassur.example",
      terms: "Contado",
    },
    {
      name: "Importaciones AutoRepuestos Lima SAC",
      taxId: "20598765433",
      lead: 7,
      whitelisted: false,
      whatsapp: "+51987000003",
      email: "cotizaciones@autorepuestoslima.example",
      terms: "Crédito 30 días",
    },
  ];
  const supplierIds: string[] = [];
  for (const def of defs) {
    supplierIds.push(
      (
        await tx.supplier.create({
          data: {
            name: def.name,
            taxId: def.taxId,
            defaultLeadTimeDays: def.lead,
            aiWhitelisted: def.whitelisted,
            whatsapp: def.whatsapp,
            email: def.email,
            paymentTerms: def.terms,
          },
        })
      ).id,
    );
  }
  const catalog: Array<[number, string, number, number, boolean]> = [];
  for (const spec of DEMO_PRODUCTS) {
    if (spec.stocked === false) continue;
    const cost = Number(spec.cost);
    if (spec.kind === "TIRE")
      catalog.push([0, spec.sku, cost, 3, true], [2, spec.sku, cost * 1.06, 7, false]);
    else if (spec.kind === "BATTERY" || spec.kind === "LUBRICANT")
      catalog.push([1, spec.sku, cost, 2, true], [2, spec.sku, cost * 1.05, 7, false]);
    else catalog.push([2, spec.sku, cost, 7, true], [1, spec.sku, cost * 1.04, 3, false]);
  }
  for (const [supplierIndex, sku, price, lead, preferred] of catalog) {
    const supplierId = supplierIds[supplierIndex];
    const productId = ids.get(sku);
    if (!supplierId || !productId) continue;
    const link = await tx.supplierProduct.create({
      data: {
        supplierId,
        productId,
        supplierSku: `S${supplierIndex + 1}-${sku}`,
        lastPrice: price.toFixed(4),
        lastPriceAt: new Date(),
        leadTimeDays: lead,
        minOrderQty: "2",
        isPreferred: preferred,
      },
    });
    await tx.supplierPriceHistory.createMany({
      data: [
        {
          supplierProductId: link.id,
          price: (price * 0.96).toFixed(4),
          currency: "PEN",
          source: "QUOTE",
          recordedAt: new Date(Date.now() - 60 * 86_400_000),
        },
        {
          supplierProductId: link.id,
          price: price.toFixed(4),
          currency: "PEN",
          source: "PURCHASE_ORDER",
          recordedAt: new Date(Date.now() - 10 * 86_400_000),
        },
      ],
    });
  }
}

interface OrderLine {
  sku?: string;
  description: string;
  type: "LABOR" | "PART";
  qty: number;
  price: string;
  consume?: boolean;
  partStatus?: "REQUESTED" | "ISSUED";
}

async function seedWorkOrders(
  tx: Tx,
  ctx: DemoSeedContext,
  ids: Map<string, string>,
): Promise<void> {
  const orders: Array<{
    customer: string;
    doc: string;
    phone: string;
    plate: string;
    make: string;
    model: string;
    year: number;
    km: number;
    status: WorkOrderStatus;
    complaint: string;
    diagnosis?: string;
    approved: boolean;
    lines: OrderLine[];
  }> = [
    {
      customer: "Carlos Mendoza",
      doc: "45678123",
      phone: "+51987111001",
      plate: "ABC123",
      make: "Toyota",
      model: "Yaris",
      year: 2018,
      km: 62_340,
      status: "DIAGNOSING",
      complaint: "Ruido metálico al frenar",
      approved: false,
      lines: [
        {
          sku: "SV-DIAGNOSTICO",
          description: "Diagnóstico computarizado",
          type: "LABOR",
          qty: 1,
          price: "60.00",
        },
      ],
    },
    {
      customer: "María Quispe",
      doc: "40123987",
      phone: "+51987111002",
      plate: "BCD456",
      make: "Hyundai",
      model: "Accent",
      year: 2016,
      km: 98_120,
      status: "AWAITING_PARTS",
      complaint: "Frenos desgastados",
      diagnosis: "Pastillas delanteras al límite; discos en buen estado",
      approved: true,
      lines: [
        {
          sku: "FR-PAST-ACCENT-BOSCH",
          description: "Pastillas Bosch delanteras",
          type: "PART",
          qty: 1,
          price: "129.00",
          partStatus: "REQUESTED",
        },
        { description: "Mano de obra: cambio de pastillas", type: "LABOR", qty: 1, price: "70.00" },
      ],
    },
    {
      customer: "Luis Ramírez",
      doc: "43219876",
      phone: "+51987111003",
      plate: "CDE789",
      make: "Kia",
      model: "Rio",
      year: 2020,
      km: 31_900,
      status: "IN_REPAIR",
      complaint: "Mantenimiento de 30 000 km",
      diagnosis: "Cambio de aceite, filtro de aceite y de aire",
      approved: true,
      lines: [
        {
          sku: "LU-5W30-CAST",
          description: "Aceite 5W-30 Castrol Edge 4L",
          type: "PART",
          qty: 1,
          price: "179.00",
          consume: true,
          partStatus: "ISSUED",
        },
        {
          sku: "FI-AIRE-KN",
          description: "Filtro de aire K&N",
          type: "PART",
          qty: 1,
          price: "149.00",
          consume: true,
          partStatus: "ISSUED",
        },
        {
          sku: "SV-CAMBIO-ACEITE",
          description: "Mano de obra: cambio de aceite y filtro",
          type: "LABOR",
          qty: 1,
          price: "40.00",
        },
      ],
    },
    {
      customer: "Ana Torres",
      doc: "47891234",
      phone: "+51987111004",
      plate: "DEF012",
      make: "Nissan",
      model: "Sentra",
      year: 2019,
      km: 54_870,
      status: "READY",
      complaint: "No arranca por las mañanas",
      diagnosis: "Batería sin carga; alternador correcto",
      approved: true,
      lines: [
        {
          sku: "BAT-12V60-ETNA",
          description: "Batería 12V 60Ah 550CCA Etna",
          type: "PART",
          qty: 1,
          price: "359.00",
          consume: true,
          partStatus: "ISSUED",
        },
        { description: "Mano de obra: cambio de batería", type: "LABOR", qty: 1, price: "30.00" },
      ],
    },
  ];

  for (const [index, spec] of orders.entries()) {
    const customer = await tx.customer.create({
      data: {
        docType: "DNI",
        docNumber: spec.doc,
        name: spec.customer,
        phone: spec.phone,
        whatsapp: spec.phone,
      },
    });
    const vehicle = await tx.vehicle.create({
      data: {
        customerId: customer.id,
        plate: spec.plate,
        make: spec.make,
        model: spec.model,
        year: spec.year,
        currentMileage: spec.km,
      },
    });
    const number = await nextSequence(tx, "WO");
    const order = await tx.workOrder.create({
      data: {
        number,
        branchId: ctx.branchId,
        customerId: customer.id,
        vehicleId: vehicle.id,
        assignedMechanicId: index === 0 ? null : ctx.mechanicId,
        status: spec.status,
        mileageIn: spec.km,
        fuelLevelEighths: 4 + index,
        complaint: spec.complaint,
        diagnosis: spec.diagnosis ?? null,
        receivedAt: new Date(Date.now() - (4 - index) * 86_400_000),
        approvedAt: spec.approved ? new Date(Date.now() - (3 - index) * 86_400_000) : null,
        approvalMethod: spec.approved ? "LINK" : null,
        createdById: ctx.adminId,
      },
    });
    let subtotal = 0;
    for (const line of spec.lines) {
      const productId = line.sku ? ids.get(line.sku) : undefined;
      let consumptionMovementId: string | null = null;
      if (line.consume && productId) {
        const product = DEMO_PRODUCTS.find((p) => p.sku === line.sku);
        let serialId: string | undefined;
        let lotId: string | undefined;
        if (product?.tracking === "SERIAL") {
          const serial = await tx.serialNumber.findFirstOrThrow({
            where: { productId, status: "IN_STOCK" },
            orderBy: { serial: "asc" },
          });
          serialId = serial.id;
          await tx.serialNumber.update({
            where: { id: serial.id },
            data: { status: "INSTALLED", soldAt: new Date() },
          });
        }
        const movement = await tx.kardexMovement.create({
          data: {
            warehouseId: ctx.warehouseId,
            productId,
            type: "WORK_ORDER_CONSUMPTION",
            quantityDelta: (-line.qty).toString(),
            referenceType: "work_order",
            referenceId: order.id,
            idempotencyKey: `demo-wo-${order.id}-${line.sku}`,
            createdById: ctx.mechanicId,
            ...(serialId ? { serialId } : {}),
            ...(lotId ? { lotId } : {}),
          },
        });
        consumptionMovementId = movement.id;
      }
      await tx.workOrderItem.create({
        data: {
          workOrderId: order.id,
          type: line.type,
          productId: productId ?? null,
          mechanicId: line.type === "LABOR" ? ctx.mechanicId : null,
          description: line.description,
          quantity: line.qty.toString(),
          unitPrice: line.price,
          approvalStatus: spec.approved ? "APPROVED" : "PENDING",
          partStatus: line.type === "PART" ? (line.partStatus ?? "REQUESTED") : "NOT_APPLICABLE",
          consumptionMovementId,
        },
      });
      subtotal += Number(line.price) * line.qty;
    }
    const total = subtotal;
    await tx.workOrder.update({
      where: { id: order.id },
      data: {
        subtotal: (total / 1.18).toFixed(2),
        taxTotal: (total - total / 1.18).toFixed(2),
        total: total.toFixed(2),
      },
    });
    await tx.workOrderChecklistItem.createMany({
      data: [
        {
          workOrderId: order.id,
          category: "INTAKE",
          label: "Nivel de combustible",
          value: `${4 + index}/8`,
        },
        {
          workOrderId: order.id,
          category: "INTAKE",
          label: "Luces de tablero encendidas",
          checked: index % 2 === 0,
        },
        {
          workOrderId: order.id,
          category: "INVENTORY",
          label: "Llanta de repuesto y gata",
          checked: true,
        },
        {
          workOrderId: order.id,
          category: "DAMAGE",
          label: "Rayón en puerta trasera derecha",
          checked: index === 1,
        },
      ],
    });
    await tx.workOrderStatusHistory.createMany({
      data: [
        {
          workOrderId: order.id,
          toStatus: "RECEIVED",
          changedById: ctx.adminId,
          note: "Recepción digital",
        },
        {
          workOrderId: order.id,
          fromStatus: "RECEIVED",
          toStatus: spec.status,
          changedById: ctx.adminId,
        },
      ],
    });
  }
}

/** Políticas de garantía de ejemplo, asignadas por tipo de producto, con una garantía activa y un recordatorio. */
async function seedWarranties(tx: Tx): Promise<void> {
  const battery = await tx.warrantyPolicy.create({
    data: {
      name: "Batería 12 meses",
      months: 12,
      terms: "Cubre defectos de fabricación. No cubre sulfatación por mal uso.",
    },
  });
  const tire = await tx.warrantyPolicy.create({
    data: {
      name: "Llanta 24 meses / 40 000 km",
      months: 24,
      kilometers: 40_000,
      terms: "Cubre defectos de fabricación; no cubre cortes ni golpes.",
    },
  });
  const labor = await tx.warrantyPolicy.create({
    data: {
      name: "Mano de obra 3 meses / 3 000 km",
      months: 3,
      kilometers: 3_000,
      coversLabor: true,
    },
  });
  await tx.product.updateMany({
    where: { kind: "BATTERY" },
    data: { warrantyPolicyId: battery.id },
  });
  await tx.product.updateMany({ where: { kind: "TIRE" }, data: { warrantyPolicyId: tire.id } });

  const vehicle = await tx.vehicle.findFirst({ where: { plate: "CDE789" } });
  if (!vehicle) return;
  const day = 86_400_000;
  await tx.warranty.create({
    data: {
      source: "WORK_ORDER_ITEM",
      customerId: vehicle.customerId,
      vehicleId: vehicle.id,
      policyId: labor.id,
      coversLabor: true,
      description: "Mano de obra: cambio de frenos (OT anterior)",
      startsAt: new Date(Date.now() - 80 * day),
      expiresAt: new Date(Date.now() + 10 * day),
      startMileage: 29_000,
      expiresAtMileage: 32_000,
    },
  });
  await tx.maintenanceReminder.create({
    data: {
      vehicleId: vehicle.id,
      description: "Cambio de aceite",
      dueDate: new Date(Date.now() + 5 * day),
      dueMileage: 36_000,
      intervalMonths: 6,
      intervalKm: 5_000,
    },
  });
}

/** Crédito autorizado a un cliente y una cotización lista para convertir en venta u OT. */
async function seedSales(tx: Tx, ids: Map<string, string>): Promise<void> {
  await tx.customer.updateMany({
    where: { docNumber: "45678123" },
    data: { creditLimit: 1000, creditDays: 15 },
  });
  const vehicle = await tx.vehicle.findFirst({ where: { plate: "BCD456" } });
  const pads = ids.get("FR-PAST-ACCENT-BOSCH");
  if (!vehicle || !pads) return;
  const price = (
    await tx.product.findFirstOrThrow({ where: { id: pads }, select: { salePrice: true } })
  ).salePrice;
  const quantity = 1;
  const labor = 70;
  const total = Number(price) * quantity + labor;
  const number = await nextSequence(tx, "QUOTE");
  await tx.quote.create({
    data: {
      number,
      customerId: vehicle.customerId,
      vehicleId: vehicle.id,
      status: "SENT",
      validUntil: new Date(Date.now() + 7 * 86_400_000),
      subtotal: (total / 1.18).toFixed(2),
      taxTotal: (total - total / 1.18).toFixed(2),
      total: total.toFixed(2),
      notes: "Cambio de pastillas delanteras",
      items: {
        create: [
          {
            productId: pads,
            description: "Pastillas Bosch delanteras",
            quantity,
            unitPrice: price.toString(),
            isLabor: false,
          },
          {
            description: "Mano de obra: cambio de pastillas",
            quantity: 1,
            unitPrice: labor,
            isLabor: true,
          },
        ],
      },
    },
  });
}

/** Siembra el sandbox completo. Se ejecuta con el rol de la app (RLS) dentro de withTenant. */
export async function seedDemoData(tx: Tx, ctx: DemoSeedContext): Promise<void> {
  const ids = await seedCatalog(tx);
  await seedStock(tx, ctx, ids);
  await seedSuppliers(tx, ids);
  await seedWorkOrders(tx, ctx, ids);
  await seedWarranties(tx);
  await seedSales(tx, ids);
}
