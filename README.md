# Mecania — ERP + POS + Taller (SaaS multi-tenant)

Plataforma para talleres mecánicos y tiendas de autopartes. Stack: Next.js (App Router) · TypeScript estricto · Tailwind · shadcn/ui · Prisma · PostgreSQL (Supabase).

Estado: **Fase 7 (final)**: dashboard y reportes, configuración por empresa y cobro de suscripciones, sobre POS/caja/facturación (Fase 6), taller y garantías (Fase 5), compras con agente IA (Fase 4), catálogo y kardex (Fase 3), autenticación/RBAC/SuperAdmin/demo (Fase 2) y el aislamiento multi-tenant (Fase 1).

## Puesta en marcha

Requisitos: Node ≥ 22, PostgreSQL 17 (con Docker: `docker compose up -d db`).

```bash
npm install
cp .env.example .env            # completa ENCRYPTION_KEY y contraseñas
npm run db:deploy               # aplica migraciones (rol dueño, DIRECT_URL)
npm run db:app-role             # habilita LOGIN del rol sas_app con APP_DB_PASSWORD
npm run db:seed                 # planes (Básico/Pro/Enterprise/Demo) y catálogo de permisos
SUPERADMIN_EMAIL=owner@tu-saas.com SUPERADMIN_PASSWORD='una-clave-larga-1' npm run superadmin:create
npm run dev
```

El SuperAdmin entra en `/login`; en el primer ingreso debe registrar el 2FA (app autenticadora). El botón **Acceso Demo** crea un taller de ejemplo por sesión.

Genera `ENCRYPTION_KEY` con: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

### Comandos

| Comando                    | Qué hace                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| `npm run lint`             | ESLint (incluye la prohibición de usar Prisma crudo fuera de `lib/db`)   |
| `npm run typecheck`        | `tsc --noEmit`                                                           |
| `npm test`                 | Vitest: unitarias + integración (crea su propia BD, ver abajo)           |
| `npm run test:unit`        | Solo unitarias (no necesitan BD)                                         |
| `npm run test:integration` | Aislamiento, RLS, privilegios, kardex, concurrencia                      |
| `npm run test:e2e`         | Playwright (build + start; necesita `.env` con BD migrada)               |
| `npm run db:migrate`       | Crear migración en desarrollo, luego `npm run db:partialize` (ver abajo) |

**Pruebas de integración:** definen `TEST_ADMIN_DATABASE_URL` (rol dueño con `CREATE DATABASE`). Cada ejecución crea una base `sas_test_<id>`, aplica las migraciones reales, habilita `sas_app` y la elimina al terminar. Corren con el rol **sin BYPASSRLS**.

> **Atención:** el rol `sas_app` es global al clúster de Postgres y cada ejecución de las pruebas le fija una contraseña de prueba. Si usas el MISMO Postgres para desarrollar y para probar, tu app dejará de conectar (`/api/health` → `degraded`) hasta que ejecutes `npm run db:app-role`. Lo más cómodo es probar contra un segundo Postgres (otro contenedor o puerto) y apuntar `TEST_ADMIN_DATABASE_URL` allí.

## Multi-tenancy: tres capas

1. **Aplicación** — `withTenant(tenantId, async (tx) => ...)` de `@/lib/db` es la única puerta a los datos. Una extensión de Prisma inyecta `tenantId` en todo `where`/`create`, excluye borrados lógicos y bloquea `delete` físico en entidades con `deletedAt`. El cliente crudo no se exporta y ESLint prohíbe importarlo fuera de `lib/db`.
2. **Base de datos (RLS)** — cada transacción ejecuta `set_config('app.tenant_id', $1, true)` en la **misma** transacción (compatible con el pooler de Supabase en modo transacción). Toda tabla con `tenantId` tiene `ENABLE` + `FORCE ROW LEVEL SECURITY` y la política `tenant_isolation`. El `tenantId` además tiene `DEFAULT app_current_tenant()`.
3. **Rol de BD** — la app usa `sas_app`: sin `BYPASSRLS`, no superusuario, no dueño de tablas, con privilegios mínimos (saldos y catálogos de solo lectura; `kardex_movements` y `audit_logs` solo `INSERT`; sin `DELETE` en tablas con borrado lógico). El cliente privilegiado (`withAdmin`) usa `ADMIN_DATABASE_URL`, exige un motivo y deja registro de auditoría antes de operar.

Además, todas las relaciones entre tablas de negocio son **FK compuestas `(tenantId, id)`**: RLS no ve las comprobaciones de FK, así que sin esto un tenant podría referenciar filas de otro.

### Reglas para escribir servicios

- Usa claves foráneas escalares (`categoryId`), no `connect`: la extensión fija `tenantId` y eso fuerza el modo "unchecked" de Prisma. Las creaciones anidadas (`batteryDetail: { create: ... }`) funcionan y heredan el tenant.
- Los `include` de relaciones **no** filtran `deletedAt` de los hijos. Consulta el hijo directamente cuando importe.
- Borrado lógico: `tx.product.update({ where, data: softDeleteData() })`. Para ver o restaurar borrados: `withTenant(id, fn, { includeDeleted: true })`.
- Las entradas de la API se validan con Zod en el borde; los errores de dominio (`lib/errors.ts`) se convierten a `Result` con `toResult()`.

### Inventario: el stock no se edita

El stock es el resultado de `kardex_movements` (solo inserción). Un trigger `SECURITY DEFINER` mantiene `stock_balances`/`stock_lot_balances` y el costo promedio ponderado dentro de la misma transacción:

- Rechaza saldo negativo (`insufficient_stock` → `InsufficientStockError`) salvo `allowNegative = true`, que el servicio solo debe enviar con el permiso `permitir_stock_negativo`.
- Dos ventas simultáneas se serializan con `FOR UPDATE`; hay una prueba con 12 ventas sobre 5 unidades.
- Los saldos no se pueden modificar por ningún otro camino (ni siquiera el dueño: trigger de guarda).
- `idempotencyKey` único por tenant evita duplicados por reintentos.
- Los servicios que muevan varios productos en una transacción deben ordenarlos (p. ej. por `productId`) para evitar deadlocks.

## Autenticación, RBAC y SuperAdmin (Fase 2)

- **Sesión:** cookie HTTP-only firmada (`jose`, HS256; `__Host-` + `Secure` en producción). Lleva `userId`, `tenantId`, `sessionVersion`, `mfa` e `imp`; **no** lleva permisos: se leen de la BD en cada petición (caché de 15 s) y se filtran por los módulos del plan. Cambiar el rol, deshabilitar al usuario, restablecer la contraseña o suspender el tenant surten efecto de inmediato.
- **Contraseñas:** `scrypt` (sal por usuario, parámetros dentro del hash), política de 10+ caracteres con letras y números, bloqueo de 15 min tras 5 fallos, tiempos iguales para "no existe" y "clave incorrecta".
- **2FA TOTP (RFC 6238)** obligatorio para SuperAdmin, secreto cifrado con AES-256-GCM atado al usuario. Sin 2FA completado la sesión solo sirve para `/login/mfa`. **Desactivación temporal:** `SUPERADMIN_REQUIRE_2FA=false` (variable de entorno) permite entrar solo con correo y contraseña, también en producción; cada ingreso así deja una advertencia en el log. Para reactivarlo, quita la variable o pon `true` y vuelve a desplegar.
- **Rate limit** en BD (`rate_limit_buckets`, válido en serverless): login por IP y por correo, 2FA, recuperación de contraseña y demo. **Captcha** Cloudflare Turnstile en "Acceso Demo" (obligatorio en producción).
- **RBAC:** `can(user, 'modulo:accion')` y `requirePermission()` en cada servicio (nunca solo en la UI). Roles base (Administrador, Jefe de Almacén, Cajero/Vendedor, Mecánico) + roles personalizados por tenant. El rol Administrador es inmutable y siempre debe quedar un administrador activo.
- **Límites de plan en el backend:** `assertWithinPlan()` (usuarios, sucursales, almacenes) y módulos efectivos (plan ∩ módulos activados por el tenant). Lanzan `PlanLimitError` / `ModuleDisabledError`.
- **SuperAdmin** (`/admin`): alta de empresas (roles, sucursal, almacén e invitación por correo), suspender/reactivar/eliminar lógicamente (retención configurable), cambio de plan con validación de uso, edición de planes, métricas (MRR, cuentas, churn, consumo de IA) e **impersonación** con motivo obligatorio, banner permanente y registro en la auditoría **del tenant**.
- **Demo:** `provisionDemo()` crea un tenant `isDemo` por sesión (24 h, plan `demo`), con 36 productos, 5 en stock crítico, 4 OT, 3 proveedores y lotes/series. Los envíos quedan `SIMULATED` (`enqueueOutbound`) y la IA queda topada a 20 000 tokens (`resolveAiPolicy`; las Fases 4 y 5 deben respetar ambos). "Restaurar demo" entrega un sandbox nuevo. El job de Inngest `demo-cleanup` (cada hora) ejecuta `purge_tenant()`, que borra todo (incluido kardex/auditoría) solo de tenants demo o cancelados con retención vencida.
- **Zona horaria:** la BD y `sas_app` deben operar en UTC (la migración lo fija); si no, el adaptador de Prisma desplaza las fechas.
- **CSRF:** las mutaciones son Server Actions (Next compara `Origin`/`Host`); los Route Handlers (`/api/inngest`) están firmados por Inngest.

## Catálogo e inventario (Fase 3)

- **Catálogo:** `createProduct()` valida por tipo con Zod (llanta: medida/índices/rack; batería: Ah, CCA, polaridad; lubricante: viscosidad; repuesto: OEM, equivalencias, compatibilidad por vehículo). Llantas se controlan por **lote = DOT**; baterías por **serie única**. Búsqueda por medida (`205/55R16`, `2055516`...), código OEM/equivalente y vehículo (marca/modelo/año). Los costos de compra solo llegan a quien tiene `purchasing:ver_costos_compra`.
- **Kardex:** todo movimiento pasa por `applyMovement()` (`server/services/inventory.ts`): lock por producto/almacén, idempotencia (`idempotencyKey`, también bajo concurrencia), FEFO por DOT en llantas, reclamo condicional de series, y el trigger de la BD que impide saldo negativo. Ventas/OT (Fases 5 y 6) deben usar `applyMovement`/`applyMovements` (orden fijo contra deadlocks), nunca escribir saldos.
- **Motor de reorden** (`server/services/reorder.ts`, fórmulas en `lib/inventory/reorder-math.ts`): demanda = 0.6·rotación 30 d + 0.4·rotación 90 d (× estacionalidad); seguridad = 1.65·σ diaria·√plazo; reorden = demanda·plazo + seguridad; mínimo = seguridad + 3 días de demanda. Plazo: proveedor preferido (si no, el más rápido, si no, 7 días). Modo AUTO/MANUAL por producto y almacén. Semáforo: crítico ≤ mínimo, reorden ≤ punto de reorden, óptimo por encima.
- **Alertas:** notificación inmediata al cruzar el umbral (una por producto/estado/día); job diario `inventory-maintenance` (recalcula, concilia saldo vs kardex y avisa de llantas con DOT antiguo).
- **Transferencias** (solicitada → en tránsito → recibida, con diferencias) y **conteo físico** (ajustes `COUNT_ADJUSTMENT_*` con motivo y auditoría).
- **Formularios:** `ActionForm` conserva los datos si la acción falla (React 19 los borraría) y los limpia solo al tener éxito.
- **CSP con nonce:** el layout raíz fuerza render dinámico (`connection()`); sin eso las páginas estáticas no se hidratan. Hay una prueba E2E de regresión.

## Compras y agente IA (Fase 4)

- **Credenciales:** la clave de OpenAI, la del webhook de WhatsApp, la contraseña SMTP y el secreto de webhooks entrantes se guardan **cifradas** (AES-256-GCM con el tenant como dato autenticado: un texto cifrado copiado a otro tenant no se puede descifrar), se muestran enmascaradas (`••••abcd`) y nunca viajan al cliente ni a logs/auditoría. Solo `loadTenantSecrets()` las descifra, para uso interno.
- **Órdenes de compra:** `Borrador → Solicitado → Cotizado → En camino → Recibido` (+ Cancelado). Recepción contra la orden (parcial o total, con lote/DOT y series), diferencias registradas (±10 % máximo de sobre-recepción), costo promedio y precios del proveedor actualizados, y devoluciones a proveedor. Todo idempotente y con auditoría.
- **Agente IA** (`server/services/purchasing-agent.ts`): lee productos bajo el punto de reorden con su rotación 30/90 d, proveedores (precio, tendencia, plazo, puntualidad de entregas, lista blanca) y lo ya pedido; llama a OpenAI con function calling (`propose_orders`, estricto) **fuera de cualquier transacción**; valida la respuesta contra la BD (ids, proveedor-producto, cantidades, **precios siempre de la BD**) y aplica los **guardrails** deterministas (`lib/ai/guardrails.ts`): monto máximo por pedido, cantidad máxima por SKU, máximo de pedidos por día, lista blanca. Cualquier violación (o modo automático sin topes) exige confirmación humana explícita. Modo `DRAFT_APPROVAL` (bandeja «Aprobar y enviar») o `AUTOMATIC`.
- **Presupuesto:** antes de llamar se comprueba el tope mensual de tokens/costo; si se agotó no se llama al modelo (corrida `BLOCKED_BUDGET` + alerta) y `max_tokens` se acota a lo que queda. Cada corrida guarda prompt, respuesta, tokens, costo estimado (tarifas en `lib/ai/pricing.ts`, orientativas) y el mensaje enviado; si falla el procesamiento posterior, el consumo se registra igual.
- **Webhook de proveedores** `POST /api/webhooks/supplier/{tenantId}`: cabeceras `x-timestamp` (epoch) y `x-signature: sha256=HMAC_SHA256(secreto, "<timestamp>.<cuerpo>")`; ventana de 5 min, rate limit por IP, tope de 256 KB, deduplicación por `externalId`. Cuerpo: `{ externalId, from, text, orderNumber?, event?: "quote"|"shipped", etaDate?, quote?: { items: [{ sku, unitPrice }] } }`. El secreto se genera en Configuración → Canales (se muestra una vez).
- **Proveedores = datos no confiables:** su texto se guarda como `untrusted`, nunca llega a un LLM como instrucción (la extracción opcional por IA no tiene herramientas y su salida se valida con Zod) y su único efecto posible es pasar la orden a **Cotizado** o **En camino**. Nunca Recibido, nunca aprobar/enviar/cambiar configuración; los precios cotizados solo se aplican cuando un humano los acepta (`acceptQuote`).
- **Envíos:** cola `OutboundMessage` con reclamo atómico, reintentos con backoff (1, 5, 15, 60, 180 min; 5 intentos) y alerta crítica al fallar. Destinos solo HTTPS con IP pública verificada por DNS (anti-SSRF), sin seguir redirecciones; SMTP solo en puertos 25/465/587/2525. «Enviar prueba» en Configuración.
- **Demo:** el agente usa propuestas controladas (sin llamar a OpenAI) y todo envío queda `SIMULATED`.
- **Jobs (Inngest):** `outbound-dispatch` (cada 2 min), `purchasing-agent` (05:00 UTC, solo tenants con plan de IA y clave).
- **Limitación conocida:** el agente trabaja sobre el almacén por defecto del tenant; la UI de recepción rápida no captura lotes/series (el servicio sí; recibir llantas/baterías por UI llegará con la UI de recepción detallada).

## Taller, clientes y garantías (Fase 5)

- **Clientes y vehículos:** un cliente tiene varios vehículos; la **placa** es única por tenant y se normaliza (`abc-123` → `ABC123`). Documento validado por tipo (DNI 8 dígitos, RUC con dígito verificador). Historial técnico por vehículo (`/app/vehicles/{id}`): kilometraje a lo largo del tiempo, servicios, repuestos instalados (con **serie** de batería o **DOT** de llanta), garantías y próximos mantenimientos.
- **Orden de trabajo:** `Recibida → En diagnóstico → Esperando aprobación → En reparación / Esperando repuesto → Lista para entrega → Entregada` (+ Cancelada); la máquina de estados está en `lib/workshop/state.ts` y cada cambio queda en el historial. Recepción digital con checklist, combustible, kilometraje (uno menor al registrado exige confirmación y queda auditado) y fotos (se valida el contenido real: JPG/PNG/WebP, máx. 5 MB, bucket privado `{tenantId}/work-orders/...`, URL firmada de 5 min). Una sola OT abierta por vehículo.
- **Presupuesto por rondas:** mano de obra y repuestos en una cuenta mixta (IGV sobre lo gravado; precio sin IGV). El cliente aprueba **por enlace** (`/aprobar/{token}`: token aleatorio, solo se guarda su hash, un solo uso, vence en 7 días, límite por IP) o **firmando en pantalla** en el taller. Puede aprobar solo una parte. Todo trabajo adicional abre una **ronda nueva** que debe aprobarse aparte: lo ya aprobado nunca cambia en silencio, y un repuesto sin aprobar no se puede entregar.
- **Repuestos:** el almacén los entrega contra una OT aprobada y salen **solo por el kardex** (`WORK_ORDER_CONSUMPTION`, FEFO en llantas, serie en baterías), de forma idempotente. Sin stock la OT pasa a «Esperando repuesto» y se avisa. Devolver o cancelar reingresa por el kardex. El mecánico solo ve sus OT y nunca los costos.
- **Garantías:** políticas por meses y/o kilómetros (con o sin mano de obra), asignables a productos y a servicios. Se **emiten al entregar** el vehículo (repuesto con su serie/DOT y mano de obra con su política), de forma idempotente; cada garantía guarda su propia vigencia, así que cambiar la política no altera las ya emitidas. Consulta rápida por placa, serie o cliente. **Reclamos:** recibido → en evaluación → aprobado/rechazado → resuelto por **reposición** (sale del kardex y hereda el tiempo restante) o **nota de crédito** (queda el monto y una alerta; la emisión fiscal llega en la Fase 6). Aprobar fuera de cobertura exige un motivo auditado.
- **WhatsApp al cliente** (solo con consentimiento y número; en demo, `SIMULATED`): presupuesto, «vehículo listo», recordatorios de mantenimiento (7 días o 500 km antes) y vencimiento de garantías (30 y 7 días). Cada aviso tiene clave idempotente: no se duplica.
- **Job diario** `workshop-maintenance` (13:00 UTC = 08:00 Lima): vence garantías y envía avisos/recordatorios por tenant.
- **Almacenamiento:** `STORAGE_DRIVER=local` guarda en `.local-storage/` (solo desarrollo/CI); en producción usa Supabase Storage con `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. La purga de una demo borra también sus archivos.

## POS, caja y facturación electrónica (Fase 6)

- **Venta de mostrador** (`/app/pos`): lector de código (Enter), búsqueda por SKU/nombre, medida de llanta, vehículo (marca/modelo) y placa (trae al cliente). Totales siempre calculados en el servidor (`lib/pos/totals.ts`, `Decimal`; respeta «precios incluyen IGV» del tenant). Pagos mixtos (efectivo, tarjeta, transferencia, Yape, Plin), vuelto, crédito y clave de idempotencia por carrito: un doble clic o un reintento no vende dos veces.
- **Stock = kardex.** Toda venta descarga **solo** con `applyMovement` (FEFO por lote, serie en baterías; una venta que toma dos lotes genera dos líneas con el importe repartido sin perder céntimos). La venta se inserta antes de mover stock para que dos peticiones idénticas no toquen el kardex dos veces. Anular reingresa con `SALE_VOID`; devolver, con `RETURN_CUSTOMER`. Las ventas de una OT **no** vuelven a descontar (el repuesto ya lo consumió la OT).
- **Descuentos:** permiso `pos:aplicar_descuentos` **y** tope por rol (`Role.maxDiscountPercent`, editable en Roles; Administrador 100 %, Cajero 10 %). El precio de un producto sale siempre del catálogo.
- **Caja:** una sola caja abierta por usuario y sucursal (índice único sobre `openKey`), movimientos de efectivo, arqueo por medio de pago y cierre. Cobros y devoluciones son filas de `SalePayment` **con signo**, así el esperado por medio es una suma exacta. Vender/cobrar toman la caja con `FOR SHARE` y el cierre con `FOR UPDATE`: nunca entra una venta a una caja cerrada. Diferencia de efectivo mayor a la tolerancia → nota obligatoria, alerta y auditoría.
- **Crédito y cuentas por cobrar:** exige cliente con línea de crédito (`creditLimit`); anticipo opcional; cobros parciales idempotentes con la cuenta bloqueada (`FOR UPDATE`); antigüedad de saldos (al día, 1–30, 31–60, 61–90, +90); job diario que marca vencidas, alerta y recuerda al cliente por WhatsApp (una vez por semana).
- **Conversiones:** cotización → venta (respeta el precio cotizado aunque cambie el catálogo; series al convertir) y cotización → OT (ítems ya aprobados); OT → venta (cuenta mixta; precios de la OT sin IGV). Cada cotización se convierte una sola vez; las vencidas no se convierten.
- **Facturación (`InvoiceProvider`):** contrato en `server/integrations/invoicing.ts`. Incluye un proveedor **simulado** (demo/pruebas; aplica validaciones tipo SUNAT: RUC, importes, serie) y un adaptador **HTTP** genérico (`POST {baseUrl}/documents` con `Authorization: Bearer`, `Idempotency-Key` = serie-correlativo; respuesta `{status: ACCEPTED|REJECTED, id, hash, xml_url, pdf_url, cdr_url, code, message}`) con protección SSRF. Para un OSE/PSE con otra API se escribe otro adaptador que implemente la misma interfaz. La carga (`lib/billing/payload.ts`) usa los códigos de los catálogos SUNAT (tipo de comprobante, identidad, afectación IGV, unidad, motivos de NC/ND) y la leyenda en letras.
- **Comprobantes:** boleta y factura nacen `PENDING` **dentro** de la transacción de la venta (serie y correlativo con `nextSequence`, un solo comprobante por venta por `docKey`) y se envían **fuera** de ella. Fallos transitorios (red, 5xx, 429) → reintento con espera creciente (1, 5, 15, 60, 180, 360, 720 min; 8 intentos; luego alerta crítica); rechazo del proveedor → `REJECTED` visible con alerta y reintento manual con el **mismo correlativo**. Un `lease` evita doble envío entre la venta y el job `invoice-dispatch` (cada 5 min). Reglas SUNAT validadas al vender: factura exige RUC válido; boleta > S/ 700 exige identificar al cliente.
- **Anulaciones y devoluciones** (permiso `pos:anular_venta`, motivo obligatorio, auditoría): anular devuelve stock, reintegra el dinero en la caja abierta, cancela la deuda, anula garantías y emite **nota de crédito** (motivo 01) si el comprobante ya fue aceptado. La devolución parcial baja primero la deuda del cliente y solo el excedente sale en dinero; «nota de crédito» solo aplica contra deuda. **Nota de débito** (intereses, penalidades) con `billing:editar`; suma a la deuda si la venta está a crédito.
- **Ticket 80 mm y A4** (`/app/sales/{id}/print?formato=ticket|a4`): datos del emisor, líneas con serie/DOT, totales, leyenda en letras y la cadena del QR de SUNAT. «Imprimir» usa el diálogo del navegador (también «Guardar como PDF»).
- **Configuración** (`/app/billing`, `billing:editar`): proveedor, URL y token (cifrado con AES-256-GCM, mostrado enmascarado, nunca auditado), series, días de crédito y tolerancia de caja. **Cuentas demo:** siempre proveedor simulado y un RUC ficticio `00000000000`.
- **Jobs (Inngest):** `invoice-dispatch` (cada 5 min) y `billing-maintenance` (14:00 UTC: deudas vencidas y cotizaciones vencidas).

### Órdenes de servicio a crédito y cobranza B2B

No hay una tabla `ServiceOrder` aparte: la **orden de trabajo (OT)** ya es la orden de servicio y se enlaza con la venta, el comprobante electrónico y la deuda, así que todo cuadra.

- **Recepción con evidencia** (`/app/workshop`): hasta 4 fotos de ingreso (JPG/PNG/WebP, 5 MB c/u, validadas por contenido) se adjuntan al abrir la orden. Las fotos son **inmutables**: un trigger de base de datos (`work_order_photos`, vía `forbid_mutation()`) impide modificarlas o borrarlas, incluso con el rol dueño; solo la purga de una demo o de un tenant con retención vencida las elimina.
- **Facturar a crédito** (en la OT lista o entregada, permiso `pos:crear`): _Condición de pago_ **A crédito** + _plazo en días_ (vacío = el del cliente o el de la empresa) + anticipo opcional. Crea la venta, la boleta/factura y la **cuenta por cobrar** con su vencimiento; exige que el cliente tenga línea de crédito. La OT muestra «Facturada a crédito», saldo y vencimiento.
- **Cuentas por cobrar** (`/app/receivables`): semáforo **verde** (a tiempo), **ámbar** (vence en ≤ 3 días) y **rojo** (vencida), ordenadas por vencimiento; resumen «Quién nos debe» por empresa (lo más urgente primero); filtros por nombre y «Solo empresas (RUC)». **Registrar pago** (total o parcial; por defecto el saldo completo) entra a la caja abierta de quien cobra, es idempotente y deja el saldo en 0 al pagar todo.
- **Recordatorios por WhatsApp** (job diario `billing-maintenance`, 09:00 Lima; cola nativa, respeta el consentimiento): un aviso **único 3 días antes** del vencimiento y un recordatorio **semanal** mientras siga vencida.
- **Libros electrónicos (PLE):** el sistema **no** genera todavía el PLE (Libro de Ventas/Diario). Cada cobro queda registrado con su método, referencia, caja y auditoría, que es la base para generarlo; falta construir ese exportador.

## Dashboard, reportes, configuración y cobro de suscripciones (Fase 7)

**Dashboard (`/app`).** Cada tarjeta se calcula solo si el rol tiene el permiso del módulo: alertas rojas de stock, ventas de hoy/ayer/mes, OT activas y atrasadas, garantías por vencer (30 días), deudas vencidas y métricas del Agente IA del mes (ahorro estimado vs costo de tokens).

**Reportes (`/app/reports`, permiso `reports:ver`).** Ventas por periodo (día o mes, hora de Lima, neto de devoluciones y cobros por medio), margen por producto, más vendidos, rotación, stock muerto, rendimiento de mecánicos, Agente IA, desempeño de proveedores y cuentas por cobrar. Cada reporte exige además su permiso propio (margen y costos solo con `purchasing:ver_costos_compra`; IA con `ai_agent:ver`). Rango máximo de 400 días. **Exportación:** «Descargar para Excel (CSV)» (UTF-8 con BOM, separador `;`, fórmulas neutralizadas contra inyección) e «Imprimir / Guardar PDF» (hoja de impresión del navegador). No se agregó una librería de `.xlsx`/PDF (regla de dependencias): el CSV abre directo en Excel.

**Cómo se calcula el ahorro del Agente IA:** `líneas de pedido generadas × minutos por línea ÷ 60 × costo por hora`, menos `costo en USD × tipo de cambio`. Es una **estimación**; los tres supuestos se editan en Configuración.

**Configuración por empresa (`/app/settings`).** Perfil (razón social, RUC, contactos), impuestos y operación (tasa, ticket 58/80 mm, antigüedad de llantas, stock negativo, ventanas de rotación y stock muerto, supuestos de IA). Todo con Zod, límites y auditoría. Protecciones: el **RUC no se cambia** si ya hay comprobantes emitidos y **«los precios incluyen IGV» no se invierte** si ya hay ventas o cotizaciones (cambiaría el significado de todos los precios). Como `tenants` y `subscriptions` son tablas de plataforma (la empresa solo las lee), las escrituras pasan por el cliente privilegiado, auditadas a nombre del usuario.

### Cobro de la suscripción del SaaS

- **Pasarela de la plataforma** (`BILLING_GATEWAY`): `stripe`, `mercadopago`, `simulated` (solo desarrollo; prohibida en producción) o `none` (sin cobro en línea: el SuperAdmin registra pagos por transferencia). **Culqi no está implementado**: no pude verificar su esquema de webhooks y no escribo código de dinero a ciegas (la interfaz `PaymentGatewayAdapter` en `server/integrations/payments.ts` está lista para agregarlo).
- **Un cobro por periodo** (`SubscriptionPayment`, único por suscripción+periodo) que acumula los reintentos. Stripe cobra la renovación solo con la tarjeta guardada (`off_session`); Mercado Pago genera un enlace de pago por periodo.
- **Ciclo (job horario `subscription-billing`):** 3 días antes del vencimiento genera el cobro y cobra/recuerda → si falla, **reintenta** a los 1, 3 y 5 días (`BILLING_RETRY_DAYS`) → al vencer el periodo pasa a **GRACIA** (`BILLING_GRACE_DAYS`, por defecto 7: conserva el acceso y muestra un banner) → al terminar la gracia, **suspensión automática** (login bloqueado, datos intactos) → **el primer pago la reactiva sola**. Solo se levantan solas las suspensiones hechas por el cobro; una suspensión manual del SuperAdmin se respeta. Cancelar termina la suscripción al final del periodo pagado.
- **Webhooks** `POST /api/webhooks/billing/{stripe|mercadopago}`: firma verificada sobre el cuerpo crudo (Stripe `t=…,v1=…`; Mercado Pago `x-signature` con `id:…;request-id:…;ts:…;`), ventana anti-replay de 5 min, límite de tamaño y de tasa, **idempotencia por id de evento** (`WebhookEvent`), y el cobro se ubica por el id que la app envió (nunca por datos del evento). Un monto o moneda distintos **no activan** nada y dejan una alerta crítica. 4xx = no reintentar; 5xx = la pasarela reintenta.
- **SuperAdmin (`/admin/billing`):** cuentas con pago pendiente, últimos cobros, **registro de pagos por transferencia** (mismo camino que un webhook) y **extensión de gracia** con motivo auditado.
- **Cuentas demo:** nunca se cobran.

## Libros electrónicos PLE para SUNAT (`/app/reports/ple`)

- **Qué genera:** el TXT del **Registro de Ventas e Ingresos (Formato 14.1, 35 campos)** y del **Registro de Compras (Formato 8.1, 42 campos)**, con la estructura de las R.S. 286-2009 y 108-2020 (Anexos 4 y 5): campos separados por `|`, periodo `AAAAMM00`, fechas `DD/MM/AAAA` (hora de Lima), importes con 2 decimales y sin separador de miles, codificación ANSI (Windows-1252) y nombre `LE`+RUC+AAAA+MM+`00`+libro+`00`+operaciones+contenido+moneda+generación`.TXT`.
- **Ventas:** salen los comprobantes **aceptados** (estado `1`) e inutilizados (estado `2`, importes en cero) cuya emisión cae en el mes. Los **pendientes o rechazados quedan fuera** y la pantalla lo avisa. Las notas de crédito restan. El campo 34 (medio de pago) se marca cuando la venta se cobró íntegra sin efectivo, según los cobros de caja.
- **Compras:** la plataforma no tenía datos estructurados del comprobante del proveedor, así que existe `PurchaseInvoice` (migración `20261103120000_purchase_invoices`) con su formulario en la misma pantalla. Se valida RUC (módulo 11), IGV contra la tasa del tenant y duplicados; anular es borrado lógico con motivo en la bitácora. Estado `1` (mismo mes), `6` (dentro de 12 meses), `7` (crédito vencido) o `0` (sin derecho a crédito).
- **Seguridad:** exige `reports:ver` (registrar/anular pide `purchasing:crear`/`eliminar`), todo pasa por `withTenant` (RLS) y cada fila se valida contra la estructura oficial antes de salir (`lib/ple/spec.ts`); si no cumple, no se entrega el archivo.
- **Formato confirmado:** el indicador «generado por PLE» del nombre va fijo en `1` y cada línea termina con `|`.
- **Convenciones que debes confirmar con tu contador** (no pude verificarlas contra una fuente primaria de SUNAT): la boleta sin cliente va con documento tipo `0` y número `00000000`; el CUO es el correlativo del mes y el asiento lleva prefijo `M`; un mes sin movimientos se exporta vacío con indicador de contenido `0`.
- **Importante:** desde 2021 SUNAT reemplazó el PLE por el **SIRE** (RVIE/RCE) para los contribuyentes obligados. Si tu empresa lo está, estos libros son de apoyo; valida el formato con el validador del PLE antes de presentarlo. Una cuenta sin RUC válido (como las demo) no puede exportar.

## Catálogo y Configuración (rediseño, fases 2 y 3)

- **Catálogo (`/app/catalog`):** paginado en el servidor (12 por página), con filtros por SKU/nombre/código de barras/OEM, medida de llanta (`205/55R16`, `205 55 16`, `205/55 r16`… equivalen), código OEM y vehículo. El semáforo de stock usa el **punto de reposición existente** (suma de las políticas por almacén): rojo en 0, ámbar en el punto o por debajo, verde por encima; sin punto de reposición, verde y sin barra (rojo si no hay stock). Costo y margen solo se envían al navegador con el permiso de ver costos.
- **Limitación de los chips «Filtro» y «Frenos»:** no hay una columna de tipo para ellos; filtran por el **nombre de la categoría** (o de su categoría padre) que contenga «filtro» o «freno». Si tu catálogo usa otros nombres (p. ej. «Pastillas» sin la palabra «freno»), esos productos no aparecerán en el chip. Lubricante, Llantas y Baterías sí filtran por tipo de producto.
- **Configuración (`/app/configuracion`):** seis pestañas (Usuarios, Roles y permisos, Datos del taller, Facturación, IA y canales, Plan y suscripción). `/app/users`, `/app/roles`, `/app/settings`, `/app/subscription` y `/app/ai` redirigen a su pestaña conservando la consulta (los retornos de pago y de aprobación de pedidos siguen funcionando).
- **Usuarios:** con una sola sucursal activa se asigna sola; límite de usuarios del plan con aviso (también al reactivar); nadie puede desactivarse a sí mismo ni dejar al tenant sin administrador; solo un administrador otorga el rol Administrador.
- **Roles:** plantilla «Asesor de servicio» creable con un clic como rol personalizado (no toca `RoleKey`) y matriz de capacidades (vender, costos, órdenes de trabajo, stock, anular, configuración).
- **Logo:** PNG, JPG o WebP (nunca SVG) de hasta 1 MB y entre 64 y 2048 px por lado; el tipo se comprueba por los bytes, no por la extensión. Se guarda en el bucket privado `receipts` bajo `{tenantId}/branding/` y se sirve con URL temporal; aparece en el ticket de venta y en la cotización.
- **Series:** boleta `B###` y factura `F###`, distintas entre sí y de las demás series (también lo imponen restricciones de la base de datos, migración `20261104120000_settings_phase3`, reversible con su `down.sql`). Cambiar una serie que ya emitió comprobantes exige una confirmación explícita y los nuevos comprobantes empiezan en el correlativo 1.
- **IA y canales:** interruptores para el agente de compras (apagado no corre ni manual ni programado), los avisos por WhatsApp a clientes y la aprobación humana. La clave de OpenAI se cifra, se muestra con los últimos 4 caracteres y nunca se escribe en la bitácora.
- **Plan:** límites con su uso y botón de WhatsApp (`NEXT_PUBLIC_SALES_WHATSAPP`) para activar o cambiar de plan.

## Mostrador (POS): rendimiento, sugerencias, SUNAT, PWA y modo sin conexión

- **Por qué se sentía lento y qué cambió.** Cada búsqueda, vista previa de totales y consulta de cliente era una _Server Action_: Next las ejecuta **en fila** (una espera a la anterior) y cada una abre una transacción a la base de datos. Ahora los totales se calculan **en el navegador** con la misma función que el servidor (`lib/pos/totals.ts`, aritmética decimal), las consultas son `GET /api/pos/*` cancelables y en paralelo, las filas del carrito están memorizadas y las pantallas tienen esqueleto de carga (`app/app/loading.tsx`). Con la CPU del celular limitada 4×, escribir y elegir un producto, cambiar cantidades o pulsar «Total exacto» responde en 50–180 ms.
- **Latencia de la base de datos en desarrollo.** En el Docker de este equipo cada ida y vuelta a Postgres tarda ~135 ms, así que una transacción (`BEGIN` + `set_config` + consulta + `COMMIT`) cuesta ~550 ms y una pantalla que hace varias consultas tarda 1–3 s. Es el entorno, no un bucle del código; en producción pon Supabase **en la misma región que las funciones de Vercel** (ver «Despliegue») y usa el pooler en modo transacción.
- **Sugerencias en tiempo real:** al escribir (nombre, SKU, marca, código de barras, OEM o medida de llanta) se despliega una lista flotante; ↑/↓ elige, Enter agrega, Esc cierra y un lector de códigos (termina en Enter) entra directo. Responde al instante con el catálogo guardado en el dispositivo y lo completa con el servidor (productos nuevos y stock actual).
- **SUNAT al vender (servidor y mostrador):** factura solo a un comprador con **RUC de 11 dígitos, dígito verificador y prefijo 10 o 20** y razón social; boleta anónima hasta **S/ 700** y, por encima, documento válido (DNI de 8 dígitos, carné de extranjería, pasaporte o RUC); serie **B###/F###** tomada de Configuración → Facturación (y verificada contra el tipo); **IGV 18 %**: si la empresa configuró otra tasa no se emiten comprobantes electrónicos; afectaciones del catálogo 07 (gravado 10, exonerado 20, inafecto 30). **Límite:** que el RUC esté _activo y habido_ solo lo confirma SUNAT; esta plataforma no tiene acceso a su padrón, así que esa comprobación la hace el OSE al enviar el comprobante (si lo rechaza, queda en «Rechazado» para corregir). El proveedor OSE/PSE sigue exigiendo HTTPS, bloquea redes internas, guarda el token cifrado y solo lo muestra enmascarado.
- **PWA:** `app/manifest.ts` (instalable, modo independiente, atajos «Nueva venta» y «Caja»), íconos en `public/icons/` (regenerables con `node scripts/generate-pwa-icons.mjs`) y `public/sw.js`. Android/Chrome: botón **Instalar app** en el menú; iPhone/iPad: Compartir → Agregar a pantalla de inicio. La interfaz respeta márgenes seguros (muesca), 16 px mínimo en campos móviles y objetivos táctiles de 44 px.
- **Modo sin conexión:** con el mostrador abierto una vez, el dispositivo guarda en **IndexedDB** el catálogo (hasta 5 000 productos con precio, afectación y stock) y la tasa de IGV, y el service worker guarda la pantalla `/app/pos`. Sin internet se puede **buscar, armar el carrito y cobrar con boleta o nota de venta**: la venta queda en una cola local con su clave de idempotencia y, al volver la conexión, `POST /api/pos/sync` la registra con **el mismo servicio de venta en línea** (permisos, caja abierta, kardex, series y correlativos, IGV). Reintentar jamás duplica; una venta rechazada (p. ej. sin caja abierta o sin stock) queda en «Revisar» con su motivo. El stock visible descuenta lo vendido sin sincronizar.
  - **Límites a propósito:** sin conexión **no** se emiten facturas (no se puede validar el RUC), ni ventas a crédito, ni productos por número de serie; la búsqueda de clientes y de placas necesita internet. El comprobante electrónico **se emite al sincronizar**, con la fecha de ese momento (la hora real del cobro queda en la bitácora): sin conexión se entrega un comprobante provisional, no el definitivo.
  - **Sincroniza con la app abierta:** al volver la red, al reabrirla y cada 30 s mientras haya pendientes (no usa Background Sync). Los datos viajan por el servidor hacia la base de datos (Supabase), nunca directo desde el navegador.
  - **Seguridad en el dispositivo:** la cola y el catálogo son por usuario y negocio (otro usuario del mismo equipo no los ve ni los envía); al cerrar sesión se borran el catálogo y las páginas guardadas y **se conservan** las ventas pendientes (se avisa antes de salir). IndexedDB no va cifrada: usa el bloqueo de pantalla del dispositivo. Safari puede borrar los datos de sitios que no se usan por 7 días: instala la app.

## Módulos, rubros y planes comerciales (SuperAdmin)

- **Módulos efectivos de un tenant** = módulos incluidos en su plan − `tenantSettings.disabledModules` (la lista antigua `enabledModules` se sigue respetando). Catálogo y presets por rubro en `lib/modules.ts`.
- **Cómo se oculta la interfaz:** `session-resolver` quita los permisos de los módulos apagados; menús, páginas y servicios ya consultan `can()`/`requirePermission`, así que se ocultan o se deniegan sin código extra. Siempre activos: Núcleo POS, Usuarios, Configuración y Auditoría.
- **Panel:** `/admin/tenants/[id]` → «Rubros y Módulos Activos» (casillas: Núcleo POS, Facturación SUNAT, IA de inventario, WhatsApp, Taller/Servicios, etc.). El rubro (`BusinessType`) aplica un preset: **Autopartes** oculta Taller y Garantías en menú y dashboard; **Mixto/Taller** los muestran.
- **Planes** (códigos `basic`/`pro`/`enterprise`):

  | Plan     | Incluye                                                         |
  | -------- | --------------------------------------------------------------- |
  | Básico   | Núcleo POS, facturación, inventario                             |
  | Standard | + Taller, Compras, WhatsApp, Contabilidad (PLE), multi-sucursal |
  | Premium  | + IA de inventario                                              |

  Al subir de plan, los módulos nuevos se activan automáticamente. Los límites de plan cuentan solo sucursales y almacenes activos.

## Creación rápida de cuentas (sin SUNAT)

- El SuperAdmin crea el tenant con correo del administrador y **contraseña temporal** (generada, nunca guardada ni auditada en claro). El RUC es opcional.
- Primer ingreso: `requireTenantUser` redirige a `/cambiar-clave` hasta definir una contraseña propia.
- Sin RUC (`fiscalReady = false`) el POS solo emite **Nota de venta** y se muestra un banner de facturación. Después se actualizan RUC oficial y correo corporativo desde el SuperAdmin o Configuración; el RUC queda bloqueado una vez emitidos comprobantes fiscales. La condición activo/habido del RUC no se verifica en línea (se valida con el OSE).

## Escáner de cámara en el POS

- Botón de cámara en el mostrador (celular, tablet, laptop; requiere HTTPS y permiso de cámara). Lee EAN/UPC, Code 128 y QR.
- Motor: `BarcodeDetector` nativo si existe; si no, `@zxing/library` (carga diferida). Un antirrebote de ventana deslizante evita lecturas duplicadas.
- Autocompletado flotante por nombre, SKU o medida de llanta.
- Prueba e2e: proyecto Playwright `camera` con cámara falsa de Chromium (`tests/fixtures/ean13.mjpeg`; regenerar con `node scripts/generate-scan-fixture.mjs`).

## Sucursales y PLE 14.1/8.1

- Sucursales y almacenes en `/app/configuracion` (pestaña Sucursales); al crear una sucursal se crea su almacén por defecto. La sucursal activa se elige en la barra superior (`user.defaultBranchId`).
- PLE: permisos del módulo Contabilidad, vista previa de validación, exportación TXT/ZIP para el contador y evento de auditoría `ple.exported`.
- Migraciones nuevas (con `down.sql`): `20261105120000_module_enum_values` y `20261105120100_modules_rubros_plans`.

## Migraciones

- Nunca edites una migración ya aplicada.
- Los índices únicos que deben respetar el borrado lógico se declaran en `schema.prisma` con `map: "..._active"`. Tras `prisma migrate dev --create-only` ejecuta `npm run db:partialize` para convertirlos en parciales (`WHERE "deletedAt" IS NULL`) y luego aplica con `npm run db:migrate`.
- **Toda migración que cree tablas debe terminar con** `SELECT apply_tenant_rls(); SELECT apply_app_privileges();`. Si se olvida, `tests/integration/rls-coverage.test.ts` falla.

## Despliegue a producción (Vercel + Supabase)

Stack de producción: **Vercel** (app Next.js) · **Supabase** (PostgreSQL + Storage) · **Inngest** (jobs programados) · **Cloudflare Turnstile** (captcha) · un SMTP · opcionalmente **Stripe** o **Mercado Pago** (cobro del SaaS). Haz los pasos **en este orden**.

### 1. Supabase (base de datos y archivos)

1. Crea el proyecto en la región más cercana a tus clientes (Perú: `sa-east-1`, São Paulo) y usa la **misma región** en Vercel. Guarda la contraseña del rol `postgres`.
2. En _Project Settings → Database → Connection string_ copia:
   - **Directa** (puerto 5432, usuario `postgres`) → será `DIRECT_URL` y `ADMIN_DATABASE_URL`. Es el rol dueño: solo para migraciones y tareas de SuperAdmin; **nunca** lo uses como `DATABASE_URL`.
   - **Pooler en modo transacción** (puerto 6543) → será `DATABASE_URL`, con el usuario **`sas_app.<project-ref>`** y la contraseña que elijas en `APP_DB_PASSWORD` (el rol `sas_app` no tiene `BYPASSRLS`; así RLS aplica siempre).
3. Desde tu máquina (o un pipeline de CI) con esas variables exportadas:

   ```bash
   export DIRECT_URL='postgresql://postgres:<clave>@db.<ref>.supabase.co:5432/postgres'
   export APP_DB_PASSWORD='<clave-larga-para-sas_app>'
   npm ci
   npm run db:deploy      # aplica TODAS las migraciones (incluye RLS y privilegios)
   npm run db:app-role    # habilita LOGIN del rol sas_app
   npm run db:seed        # planes (Básico/Pro/Enterprise/Demo) y catálogo de permisos
   ```

4. En el _SQL Editor_ ejecuta `supabase/storage-policies.sql` (buckets privados `work-order-photos` y `receipts`; es idempotente).
5. En _Project Settings → API_ copia la URL del proyecto (`SUPABASE_URL`) y la clave **service_role** (`SUPABASE_SERVICE_ROLE_KEY`; solo servidor, nunca al navegador).
6. Crea al **SuperAdmin** (una vez): `SUPERADMIN_EMAIL=tu@correo.com SUPERADMIN_PASSWORD='una-clave-larga-1' npm run superadmin:create`. En el primer ingreso registra el 2FA.

### 2. Servicios externos

> **WhatsApp comercial:** define `NEXT_PUBLIC_SALES_WHATSAPP` (p. ej. `51987654321`) para que el botón **Activar plan** de las cuentas demo abra WhatsApp con el mensaje «Hola, quiero activar el plan para mi taller (cuenta demo: …)». Sin la variable, el botón lleva a `/app/subscription`.
>
> **Turnstile en Vercel:** en Cloudflare → Turnstile crea un widget **Managed** con tu dominio (`tu-app.vercel.app`) y copia la _Site key_ y la _Secret key_ reales. En Vercel → Settings → Environment Variables (entorno **Production**) define `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (Site key) y `TURNSTILE_SECRET_KEY` (Secret key) y **vuelve a desplegar** (la clave pública se incrusta al compilar). Si el widget dice «Solo para pruebas», sigues usando las claves de prueba de Cloudflare.

| Servicio                                               | Qué hacer                                                              | Variables                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Cloudflare Turnstile**                               | Crea un widget para tu dominio                                         | `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`                                |
| **SMTP** (invitaciones, recuperación, avisos de cobro) | Cuenta en tu proveedor (Resend, SES, Postmark…)                        | `SMTP_URL` (p. ej. `smtps://usuario:clave@smtp.proveedor.com:465`), `SMTP_FROM`         |
| **Inngest**                                            | Crea una app y copia las claves                                        | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                              |
| **Stripe** (si cobras con Stripe)                      | Clave secreta y un endpoint de webhook (ver abajo)                     | `BILLING_GATEWAY=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                  |
| **Mercado Pago** (si cobras con él)                    | Access token de tu aplicación y la clave secreta de las notificaciones | `BILLING_GATEWAY=mercadopago`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` |

OpenAI, el webhook de WhatsApp, el SMTP propio y el proveedor de facturación electrónica **no** son variables de entorno: cada empresa los configura (cifrados) en _Configuración_ y _Facturación_.

### 3. Vercel (la aplicación)

1. Importa el repositorio en Vercel (framework: Next.js; **Node 22+**). Build command: `npm run build` (ya ejecuta `prisma generate`); no hace falta cambiar nada más.
2. En _Settings → Environment Variables_ (entorno **Production**) define **todas** estas variables (el arranque falla con un mensaje claro si falta o es inválida alguna):

   ```
   NODE_ENV=production                       # Vercel ya lo establece
   APP_URL=https://app.tu-dominio.com        # sin barra final; se usa en enlaces, webhooks y correos
   DATABASE_URL=postgresql://sas_app.<ref>:<APP_DB_PASSWORD>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
   ADMIN_DATABASE_URL=postgresql://postgres:<clave>@db.<ref>.supabase.co:5432/postgres
   ENCRYPTION_KEY=<32 bytes en base64>       # node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   SESSION_SECRET=<mínimo 32 caracteres>     # node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   SMTP_URL=...  SMTP_FROM="Mecania <no-reply@tu-dominio.com>"
   TURNSTILE_SECRET_KEY=...  NEXT_PUBLIC_TURNSTILE_SITE_KEY=...
   SUPABASE_URL=https://<ref>.supabase.co  SUPABASE_SERVICE_ROLE_KEY=...
   INNGEST_EVENT_KEY=...  INNGEST_SIGNING_KEY=...
   BILLING_GATEWAY=none|stripe|mercadopago   # + las claves de la pasarela elegida
   BILLING_GRACE_DAYS=7  BILLING_RETRY_DAYS=1,3,5
   LOG_LEVEL=info
   ```

   **No definas** `STORAGE_DRIVER=local` (en Vercel el disco es efímero) ni `BILLING_GATEWAY=simulated` (la app se niega a arrancar). **Haz una copia segura de `ENCRYPTION_KEY`**: sin ella las credenciales cifradas de las empresas son irrecuperables.

3. Asocia tu dominio (HTTPS lo da Vercel; la app ya envía HSTS y CSP con nonce).
4. Despliega (`git push` a la rama de producción). Comprueba `https://app.tu-dominio.com/api/health` → `{"status":"ok","database":true}`.

### 4. Inngest (jobs programados)

En el panel de Inngest: _Apps → Sync new app_ con la URL `https://app.tu-dominio.com/api/inngest` (requiere `INNGEST_SIGNING_KEY`; el endpoint rechaza peticiones sin firma). Deben aparecer estas 8 funciones:

| Función                 | Programación (UTC) | Qué hace                                                  |
| ----------------------- | ------------------ | --------------------------------------------------------- |
| `outbound-dispatch`     | cada 2 min         | Envía WhatsApp/correos en cola con reintentos             |
| `invoice-dispatch`      | cada 5 min         | Envía comprobantes pendientes al OSE/PSE                  |
| `subscription-billing`  | cada hora          | Renovaciones, reintentos de cobro, gracia y suspensión    |
| `demo-cleanup`          | cada hora          | Purga cuentas demo vencidas y sus archivos                |
| `inventory-maintenance` | 04:00              | Reorden, conciliación del kardex, llantas con DOT antiguo |
| `purchasing-agent`      | 05:00              | Agente IA de compras (empresas con plan y clave)          |
| `workshop-maintenance`  | 13:00 (08:00 Lima) | Garantías por vencer y recordatorios de mantenimiento     |
| `billing-maintenance`   | 14:00 (09:00 Lima) | Deudas vencidas y cotizaciones vencidas                   |

### 5. Webhooks de la pasarela de cobro

- **Stripe** → _Developers → Webhooks → Add endpoint_: URL `https://app.tu-dominio.com/api/webhooks/billing/stripe`, eventos `payment_intent.succeeded` y `payment_intent.payment_failed`. Copia el _Signing secret_ (`whsec_…`) a `STRIPE_WEBHOOK_SECRET`.
- **Mercado Pago** → _Tus integraciones → Webhooks_: URL `https://app.tu-dominio.com/api/webhooks/billing/mercadopago`, tópico **Pagos**. Copia la clave secreta a `MERCADOPAGO_WEBHOOK_SECRET`.
- Pruébalo en modo prueba de la pasarela (tarjeta de prueba) **antes** de cobrar de verdad: paga una suscripción de una empresa de prueba y confirma que pasa a «Al día» y que el reenvío del mismo evento no extiende dos veces.

### 6. Después del primer despliegue

1. Entra como SuperAdmin → _Planes_: fija los precios y límites reales de cada plan.
2. _Empresas → Nueva empresa_: crea la primera empresa cliente; completa RUC, facturación (proveedor OSE/PSE y series) y los canales en su _Configuración_.
3. Prueba de humo en producción: `Acceso Demo`, una venta con boleta, una OT con aprobación por enlace y un reporte descargado.

### Checklist de salida a producción

- [ ] Todas las variables definidas; `GET /api/health` responde con la base conectada.
- [ ] `DATABASE_URL` usa el usuario `sas_app` por el pooler (6543); **no** el rol `postgres`.
- [ ] `npm run db:deploy` aplicó todas las migraciones y `tests/integration/rls-coverage.test.ts` pasó en CI sobre la misma versión.
- [ ] SuperAdmin creado con 2FA activo; contraseña en un gestor.
- [ ] `ENCRYPTION_KEY` y `SESSION_SECRET` respaldadas fuera de Vercel.
- [ ] Turnstile, SMTP (correo de invitación recibido de verdad) e Inngest sincronizado con las 8 funciones.
- [ ] Webhook de la pasarela probado con un pago real de prueba; `BILLING_GATEWAY` no es `simulated`.
- [ ] Backups verificados (ver abajo) y **una restauración de prueba** hecha al menos una vez.
- [ ] Precios de los planes revisados; dominio con HTTPS y `APP_URL` correcta.
- [ ] Alertas: revisa los logs de Vercel (`LOG_LEVEL=info`) y el panel de Inngest tras la primera noche.

## Backups y plan de recuperación

**Qué hay que proteger:** (1) la base de datos, (2) los archivos de Storage (fotos de OT, firmas), (3) `ENCRYPTION_KEY`/`SESSION_SECRET`.

- **Base de datos.** Supabase hace copias diarias en los planes de pago; activa **Point-in-Time Recovery** si necesitas restaurar a un minuto concreto. Además toma tu propia copia lógica, fuera de Supabase:

  ```bash
  pg_dump "$DIRECT_URL" --format=custom --no-owner --file="mecania-$(date +%F).dump"
  ```

  Prográmala (cron/GitHub Actions) al menos semanal, cífrala y guárdala en otro proveedor.

- **Storage.** Las copias de Supabase no incluyen los archivos de Storage; exporta los buckets `work-order-photos` y `receipts` periódicamente (por ejemplo con la CLI de Supabase o `rclone` contra su API S3) o aplica una política de retención aceptable para fotos.
- **Secretos.** Guarda `ENCRYPTION_KEY` y `SESSION_SECRET` en un gestor de secretos con acceso restringido y copia offline.
- **Inmutabilidad.** El kardex y la auditoría no se editan ni borran por diseño; una restauración nunca debe «arreglar» saldos a mano: los saldos se verifican con el job de conciliación.

**Restauración (procedimiento).**

1. Declara el incidente; pon la app en mantenimiento (por ejemplo suspendiendo el despliegue o con el modo de mantenimiento de Vercel).
2. Restaura: PITR/copia de Supabase al momento anterior al daño, **o** crea un proyecto nuevo y carga el volcado: `pg_restore --no-owner --dbname "$DIRECT_URL" mecania-AAAA-MM-DD.dump`.
3. Ejecuta `npm run db:deploy` (no cambia nada si ya está al día; aplica las migraciones pendientes si el respaldo es más viejo) y `npm run db:app-role`.
4. Apunta `DATABASE_URL`/`ADMIN_DATABASE_URL` al proyecto restaurado y redespliega. Sincroniza Inngest.
5. Verifica: `/api/health`, un inicio de sesión, una venta de prueba y la conciliación de inventario (job `inventory-maintenance`, o espera a la corrida de las 04:00).
6. Los comprobantes electrónicos enviados después del respaldo ya existen en SUNAT/OSE: concilia los correlativos antes de emitir nuevos (la numeración vive en `document_sequences`).

**Objetivos recomendados** (ajústalos a tu plan de Supabase, no son una garantía del sistema): RPO ≤ 24 h con copias diarias (≤ 5 min con PITR) y RTO ≤ 4 h. **Ensaya la restauración cada trimestre** en un proyecto aparte.

**Revertir un despliegue.** Vercel permite volver al despliegue anterior en un clic. Las migraciones de Prisma son hacia adelante (nunca se editan): para que un rollback de código sea seguro, haz los cambios de esquema en dos pasos (primero agregar columnas/tablas compatibles, luego retirar lo viejo en un despliegue posterior).

## Estructura

```
app/                 rutas (solo UI y composición)
components/          componentes de UI (shadcn)
lib/db/              Prisma extendido, scope de tenant, RLS helper, correlativos
lib/security/        cifrado AES-256-GCM, rutas de Storage
lib/                 env (Zod), logger (pino), errores, Result, i18n
prisma/              schema.prisma y migraciones (init + rls_and_guards + ...)
server/services/     lógica de negocio (Fase 2 en adelante)
supabase/            SQL de Storage
tests/               unit, integration, e2e
scripts/             partialize-migration, db-app-role
```

# sas-mecanica
