-- Tenant de la transacción actual (GUC `app.tenant_id`, fijado con set_config(..., true)).
-- Devuelve NULL si no hay contexto => DEFAULT/RLS fallan cerrado.
-- Se declara aquí porque los DEFAULT de "tenantId" la referencian.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('CULQI', 'MERCADOPAGO', 'STRIPE');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AppModule" AS ENUM ('USERS', 'CUSTOMERS', 'CATALOG', 'INVENTORY', 'PURCHASING', 'AI_AGENT', 'WORKSHOP', 'WARRANTIES', 'POS', 'CASH', 'BILLING', 'REPORTS', 'SETTINGS', 'AUDIT');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('ver', 'crear', 'editar', 'eliminar', 'aplicar_descuentos', 'ver_costos_compra', 'autorizar_pedidos_ia', 'anular_venta', 'cerrar_caja', 'permitir_stock_negativo');

-- CreateEnum
CREATE TYPE "RoleKey" AS ENUM ('admin', 'warehouse_manager', 'cashier', 'mechanic');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('INVITE', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('DRAFT_APPROVAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "WhatsAppProvider" AS ENUM ('N8N', 'EVOLUTION', 'BUSINESS');

-- CreateEnum
CREATE TYPE "DocumentIdType" AS ENUM ('DNI', 'RUC', 'CE', 'PASSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('TIRE', 'BATTERY', 'LUBRICANT', 'PART', 'ACCESSORY', 'SERVICE');

-- CreateEnum
CREATE TYPE "TrackingMode" AS ENUM ('NONE', 'LOT', 'SERIAL');

-- CreateEnum
CREATE TYPE "TaxAffectation" AS ENUM ('TAXED', 'EXEMPT', 'UNAFFECTED');

-- CreateEnum
CREATE TYPE "BatteryPolarity" AS ENUM ('LEFT_POSITIVE', 'RIGHT_POSITIVE');

-- CreateEnum
CREATE TYPE "LubricantBase" AS ENUM ('MINERAL', 'SEMI_SYNTHETIC', 'SYNTHETIC');

-- CreateEnum
CREATE TYPE "EquivalenceType" AS ENUM ('OEM', 'ALTERNATIVE');

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'IN_TRANSIT', 'SOLD', 'INSTALLED', 'IN_CLAIM', 'RETURNED_TO_SUPPLIER', 'SCRAP');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('INITIAL', 'PURCHASE', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'COUNT_ADJUSTMENT_IN', 'COUNT_ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN_CUSTOMER', 'RETURN_SUPPLIER', 'WORK_ORDER_CONSUMPTION', 'WORK_ORDER_RETURN', 'SALE_VOID');

-- CreateEnum
CREATE TYPE "ReorderMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InventoryCountStatus" AS ENUM ('OPEN', 'CLOSED', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'REQUESTED', 'QUOTED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrigin" AS ENUM ('MANUAL', 'AI');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SIMULATED');

-- CreateEnum
CREATE TYPE "AiRunKind" AS ENUM ('PURCHASING', 'SUPPLIER_REPLY_PARSE', 'OTHER');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED_BUDGET');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SENT');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('RECEIVED', 'DIAGNOSING', 'AWAITING_APPROVAL', 'AWAITING_PARTS', 'IN_REPAIR', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkOrderItemType" AS ENUM ('LABOR', 'PART');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PartRequestStatus" AS ENUM ('NOT_APPLICABLE', 'REQUESTED', 'ISSUED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ChecklistCategory" AS ENUM ('INTAKE', 'DAMAGE', 'INVENTORY');

-- CreateEnum
CREATE TYPE "PhotoKind" AS ENUM ('INTAKE', 'DAMAGE', 'PROGRESS', 'DELIVERY');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'NOTIFIED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "SalePaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN', 'OTHER');

-- CreateEnum
CREATE TYPE "ReceivableStatus" AS ENUM ('OPEN', 'PARTIAL', 'PAID', 'OVERDUE', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "ReturnResolution" AS ENUM ('REFUND', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('BOLETA', 'FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'NOTA_VENTA');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "WarrantySource" AS ENUM ('SALE_ITEM', 'WORK_ORDER_ITEM');

-- CreateEnum
CREATE TYPE "WarrantyStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'IN_CLAIM', 'VOID');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('RECEIVED', 'EVALUATING', 'APPROVED', 'REJECTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ClaimResolution" AS ENUM ('NONE', 'REPLACEMENT', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SUPERADMIN', 'SYSTEM', 'AI', 'WEBHOOK');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMonthly" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "maxBranches" INTEGER,
    "maxUsers" INTEGER,
    "maxWarehouses" INTEGER,
    "monthlyAiTokens" INTEGER,
    "multiWarehouse" BOOLEAN NOT NULL DEFAULT false,
    "fullWorkshop" BOOLEAN NOT NULL DEFAULT false,
    "stockAlerts" BOOLEAN NOT NULL DEFAULT false,
    "aiPurchasingAgent" BOOLEAN NOT NULL DEFAULT false,
    "includedModules" "AppModule"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "module" "AppModule" NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "taxIdType" TEXT NOT NULL DEFAULT 'RUC',
    "taxId" TEXT,
    "country" TEXT NOT NULL DEFAULT 'PE',
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "timezone" TEXT NOT NULL DEFAULT 'America/Lima',
    "locale" TEXT NOT NULL DEFAULT 'es-PE',
    "address" TEXT,
    "city" TEXT,
    "phone" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "billingEmail" TEXT,
    "logoUrl" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedAt" TIMESTAMPTZ(3),
    "suspendedReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "purgeAfter" TIMESTAMPTZ(3),
    "planId" UUID NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoExpiresAt" TIMESTAMPTZ(3),
    "demoSessionKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "taxName" TEXT NOT NULL DEFAULT 'IGV',
    "taxRate" DECIMAL(7,4) NOT NULL DEFAULT 0.18,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
    "enabledDocumentTypes" "DocumentType"[] DEFAULT ARRAY['BOLETA', 'FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'NOTA_VENTA']::"DocumentType"[],
    "invoiceProvider" TEXT,
    "invoiceConfigEncrypted" TEXT,
    "ticketWidthMm" INTEGER NOT NULL DEFAULT 80,
    "enabledModules" "AppModule"[],
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
    "tireMaxAgeYears" INTEGER NOT NULL DEFAULT 5,
    "rotationWindowDays" INTEGER NOT NULL DEFAULT 30,
    "openaiApiKeyEncrypted" TEXT,
    "openaiApiKeyHint" TEXT,
    "aiModel" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "aiTone" TEXT,
    "aiMode" "AiMode" NOT NULL DEFAULT 'DRAFT_APPROVAL',
    "aiMonthlyTokenCap" INTEGER,
    "aiMonthlyCostCapUsd" DECIMAL(12,4),
    "aiMaxOrderAmount" DECIMAL(14,2),
    "aiMaxQtyPerSku" DECIMAL(14,4),
    "aiMaxOrdersPerDay" INTEGER NOT NULL DEFAULT 5,
    "aiAutomationRules" JSONB,
    "whatsappProvider" "WhatsAppProvider",
    "whatsappWebhookUrl" TEXT,
    "whatsappApiKeyEncrypted" TEXT,
    "whatsappApiKeyHint" TEXT,
    "whatsappInboundSecretEncrypted" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "smtpUser" TEXT,
    "smtpPasswordEncrypted" TEXT,
    "smtpPasswordHint" TEXT,
    "smtpFromAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "gateway" "PaymentGateway",
    "gatewayCustomerId" TEXT,
    "gatewaySubscriptionId" TEXT,
    "trialEndsAt" TIMESTAMPTZ(3),
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "graceEndsAt" TIMESTAMPTZ(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMPTZ(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "subscriptionId" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "gatewayPaymentId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "branchId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "key" "RoleKey",
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "roleId" UUID,
    "defaultBranchId" UUID,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "totpSecretEncrypted" TEXT,
    "totpEnabledAt" TIMESTAMPTZ(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "userId" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "superAdminUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "ip" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "docType" "DocumentIdType" NOT NULL DEFAULT 'DNI',
    "docNumber" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "whatsappOptIn" BOOLEAN NOT NULL DEFAULT true,
    "address" TEXT,
    "creditLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "customerId" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "engine" TEXT,
    "vin" TEXT,
    "color" TEXT,
    "fuelType" TEXT,
    "currentMileage" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_reminders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "vehicleId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "dueDate" TIMESTAMPTZ(3),
    "dueMileage" INTEGER,
    "intervalMonths" INTEGER,
    "intervalKm" INTEGER,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "lastNotifiedAt" TIMESTAMPTZ(3),
    "sourceWorkOrderId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_policies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "name" TEXT NOT NULL,
    "months" INTEGER,
    "kilometers" INTEGER,
    "coversLabor" BOOLEAN NOT NULL DEFAULT false,
    "terms" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "warranty_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "ProductKind" NOT NULL,
    "brand" TEXT,
    "categoryId" UUID,
    "unit" TEXT NOT NULL DEFAULT 'UND',
    "isStocked" BOOLEAN NOT NULL DEFAULT true,
    "trackingMode" "TrackingMode" NOT NULL DEFAULT 'NONE',
    "taxAffectation" "TaxAffectation" NOT NULL DEFAULT 'TAXED',
    "salePrice" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "lastPurchaseCost" DECIMAL(14,4),
    "warrantyPolicyId" UUID,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tire_details" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "width" INTEGER NOT NULL,
    "aspectRatio" INTEGER NOT NULL,
    "rimDiameter" DECIMAL(4,1) NOT NULL,
    "loadIndex" INTEGER,
    "speedRating" TEXT,
    "design" TEXT,
    "season" TEXT,
    "runFlat" BOOLEAN NOT NULL DEFAULT false,
    "rackLocation" TEXT,

    CONSTRAINT "tire_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battery_details" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "voltage" INTEGER NOT NULL DEFAULT 12,
    "capacityAh" INTEGER NOT NULL,
    "ccaA" INTEGER NOT NULL,
    "polarity" "BatteryPolarity" NOT NULL,
    "terminalType" TEXT,
    "technology" TEXT,

    CONSTRAINT "battery_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lubricant_details" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "viscosity" TEXT NOT NULL,
    "baseType" "LubricantBase",
    "apiSpec" TEXT,
    "aceaSpec" TEXT,
    "volumeLiters" DECIMAL(8,2),

    CONSTRAINT "lubricant_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_details" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "oemCode" TEXT,
    "partNumber" TEXT,
    "isOem" BOOLEAN NOT NULL DEFAULT false,
    "partCategory" TEXT,
    "position" TEXT,

    CONSTRAINT "part_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_equivalences" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "brand" TEXT,
    "type" "EquivalenceType" NOT NULL DEFAULT 'ALTERNATIVE',
    "note" TEXT,

    CONSTRAINT "part_equivalences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_compatibilities" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "yearFrom" INTEGER,
    "yearTo" INTEGER,
    "engine" TEXT,
    "notes" TEXT,

    CONSTRAINT "vehicle_compatibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "address" TEXT,
    "defaultLeadTimeDays" INTEGER,
    "paymentTerms" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "aiWhitelisted" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "supplierId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "supplierSku" TEXT,
    "lastPrice" DECIMAL(14,4),
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "lastPriceAt" TIMESTAMPTZ(3),
    "leadTimeDays" INTEGER,
    "minOrderQty" DECIMAL(14,4),
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_price_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "supplierProductId" UUID NOT NULL,
    "price" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "dotCode" TEXT,
    "manufacturedAt" DATE,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unitCost" DECIMAL(14,4),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_numbers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "productId" UUID NOT NULL,
    "lotId" UUID,
    "warehouseId" UUID,
    "serial" TEXT NOT NULL,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "soldAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "serial_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "warehouseId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "avgCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lot_balances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "warehouseId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lot_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reorder_policies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "warehouseId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "mode" "ReorderMode" NOT NULL DEFAULT 'AUTO',
    "manualMinStock" DECIMAL(14,4),
    "manualReorderPoint" DECIMAL(14,4),
    "computedMinStock" DECIMAL(14,4),
    "computedReorderPoint" DECIMAL(14,4),
    "avgDailySales30" DECIMAL(14,4),
    "avgDailySales90" DECIMAL(14,4),
    "seasonalityFactor" DECIMAL(6,3) NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reorder_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kardex_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "warehouseId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotId" UUID,
    "serialId" UUID,
    "type" "MovementType" NOT NULL,
    "quantityDelta" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,4),
    "balanceAfter" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "avgCostAfter" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" UUID,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kardex_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "fromWarehouseId" UUID NOT NULL,
    "toWarehouseId" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "requestedById" UUID,
    "shippedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "transferId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotId" UUID,
    "serialId" UUID,
    "qtyRequested" DECIMAL(14,4) NOT NULL,
    "qtyShipped" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "qtyReceived" DECIMAL(14,4) NOT NULL DEFAULT 0,

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_counts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "warehouseId" UUID NOT NULL,
    "cyclic" BOOLEAN NOT NULL DEFAULT true,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "countId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotId" UUID,
    "systemQty" DECIMAL(14,4) NOT NULL,
    "countedQty" DECIMAL(14,4),
    "adjustmentMovementId" UUID,
    "notes" TEXT,

    CONSTRAINT "inventory_count_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "supplierId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "origin" "PurchaseOrigin" NOT NULL DEFAULT 'MANUAL',
    "aiRunId" UUID,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "conditions" TEXT,
    "expectedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "quotedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdById" UUID,
    "approvedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "qtyOrdered" DECIMAL(14,4) NOT NULL,
    "qtyReceived" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "taxRate" DECIMAL(7,4) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "orderId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "supplierDocRef" TEXT,
    "notes" TEXT,
    "receivedById" UUID,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "receiptId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotId" UUID,
    "serialId" UUID,
    "qtyExpected" DECIMAL(14,4) NOT NULL,
    "qtyReceived" DECIMAL(14,4) NOT NULL,
    "difference" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "kardexMovementId" UUID,
    "notes" TEXT,

    CONSTRAINT "purchase_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_returns" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "supplierId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "orderId" UUID,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_return_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "returnId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "kardexMovementId" UUID,

    CONSTRAINT "supplier_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "supplierId" UUID NOT NULL,
    "orderId" UUID,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "body" TEXT NOT NULL,
    "untrusted" BOOLEAN NOT NULL DEFAULT true,
    "externalId" TEXT,
    "parsed" JSONB,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "kind" "AiRunKind" NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'RUNNING',
    "model" TEXT NOT NULL,
    "prompt" JSONB NOT NULL,
    "response" JSONB,
    "sentMessage" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "triggeredById" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_order_drafts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "aiRunId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "messageDraft" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "requiresHuman" BOOLEAN NOT NULL DEFAULT true,
    "guardrailViolations" JSONB,
    "purchaseOrderId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_order_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_order_draft_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "draftId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "rationale" TEXT,

    CONSTRAINT "ai_order_draft_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "assignedMechanicId" UUID,
    "quoteId" UUID,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "mileageIn" INTEGER,
    "mileageOut" INTEGER,
    "fuelLevelEighths" INTEGER,
    "complaint" TEXT,
    "diagnosis" TEXT,
    "internalNotes" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promisedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "approvalTokenHash" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "approvalMethod" TEXT,
    "signatureUrl" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "workOrderId" UUID NOT NULL,
    "type" "WorkOrderItemType" NOT NULL,
    "productId" UUID,
    "mechanicId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAffectation" "TaxAffectation" NOT NULL DEFAULT 'TAXED',
    "approvalRound" INTEGER NOT NULL DEFAULT 1,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "partStatus" "PartRequestStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "consumptionMovementId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_checklist_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "workOrderId" UUID NOT NULL,
    "category" "ChecklistCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "value" TEXT,
    "notes" TEXT,

    CONSTRAINT "work_order_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_photos" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "workOrderId" UUID NOT NULL,
    "kind" "PhotoKind" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "caption" TEXT,
    "takenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" UUID,

    CONSTRAINT "work_order_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_status_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "workOrderId" UUID NOT NULL,
    "fromStatus" "WorkOrderStatus",
    "toStatus" "WorkOrderStatus" NOT NULL,
    "changedById" UUID,
    "note" TEXT,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "customerId" UUID,
    "vehicleId" UUID,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "validUntil" TIMESTAMPTZ(3),
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "quoteId" UUID NOT NULL,
    "productId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAffectation" "TaxAffectation" NOT NULL DEFAULT 'TAXED',
    "isLabor" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "branchId" UUID NOT NULL,
    "openedById" UUID NOT NULL,
    "closedById" UUID,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openingAmount" DECIMAL(14,2) NOT NULL,
    "expectedAmount" DECIMAL(14,2),
    "countedAmount" DECIMAL(14,2),
    "difference" DECIMAL(14,2),
    "closingBreakdown" JSONB,
    "notes" TEXT,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "sessionId" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "cashSessionId" UUID,
    "customerId" UUID,
    "vehicleId" UUID,
    "workOrderId" UUID,
    "quoteId" UUID,
    "sellerId" UUID,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "SalePaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "isCredit" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "saleId" UUID NOT NULL,
    "productId" UUID,
    "lotId" UUID,
    "serialId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAffectation" "TaxAffectation" NOT NULL DEFAULT 'TAXED',
    "taxRate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "kardexMovementId" UUID,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "saleId" UUID NOT NULL,
    "cashSessionId" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "receivedById" UUID,
    "paidAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivables" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "saleId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "dueDate" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReceivableStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receivables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "saleId" UUID NOT NULL,
    "resolution" "ReturnResolution" NOT NULL,
    "reason" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "returnId" UUID NOT NULL,
    "saleItemId" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "kardexMovementId" UUID,

    CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "saleId" UUID,
    "relatedDocumentId" UUID,
    "type" "DocumentType" NOT NULL,
    "series" TEXT NOT NULL,
    "correlative" INTEGER NOT NULL,
    "issueDate" TIMESTAMPTZ(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "customerSnapshot" JSONB NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "status" "FiscalStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "hash" TEXT,
    "xmlUrl" TEXT,
    "pdfUrl" TEXT,
    "cdrUrl" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranties" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "source" "WarrantySource" NOT NULL,
    "customerId" UUID,
    "vehicleId" UUID,
    "productId" UUID,
    "policyId" UUID,
    "saleItemId" UUID,
    "workOrderItemId" UUID,
    "serialId" UUID,
    "lotId" UUID,
    "description" TEXT NOT NULL,
    "status" "WarrantyStatus" NOT NULL DEFAULT 'ACTIVE',
    "coversLabor" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "expiresAtMileage" INTEGER,
    "startMileage" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "warranties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_claims" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "number" INTEGER NOT NULL,
    "warrantyId" UUID NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'RECEIVED',
    "resolution" "ClaimResolution" NOT NULL DEFAULT 'NONE',
    "description" TEXT NOT NULL,
    "evaluation" TEXT,
    "receivedById" UUID,
    "evaluatedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "warranty_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "docType" TEXT NOT NULL,
    "series" TEXT NOT NULL DEFAULT '',
    "current" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "userId" UUID,
    "kind" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "channel" "MessageChannel" NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "error" TEXT,
    "relatedType" TEXT,
    "relatedId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" UUID,
    "impersonatorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_module_action_key" ON "permissions"("module", "action");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_demoSessionKey_key" ON "tenants"("demoSessionKey");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenants_isDemo_demoExpiresAt_idx" ON "tenants"("isDemo", "demoExpiresAt");

-- CreateIndex
CREATE INDEX "tenants_planId_idx" ON "tenants"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_taxId_active" ON "tenants"("taxIdType", "taxId") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenantId_key" ON "tenant_settings"("tenantId");

-- CreateIndex
CREATE INDEX "subscriptions_tenantId_status_idx" ON "subscriptions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_nextRetryAt_idx" ON "subscriptions"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_id_key" ON "subscriptions"("tenantId", "id");

-- CreateIndex
CREATE INDEX "subscription_payments_tenantId_subscriptionId_idx" ON "subscription_payments"("tenantId", "subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_gateway_gatewayPaymentId_key" ON "subscription_payments"("gateway", "gatewayPaymentId");

-- CreateIndex
CREATE INDEX "webhook_events_tenantId_receivedAt_idx" ON "webhook_events"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_source_externalId_key" ON "webhook_events"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenantId_id_key" ON "branches"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenantId_code_active" ON "branches"("tenantId", "code") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "warehouses_tenantId_branchId_idx" ON "warehouses"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenantId_id_key" ON "warehouses"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenantId_code_active" ON "warehouses"("tenantId", "code") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_id_key" ON "roles"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_name_active" ON "roles"("tenantId", "name") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "role_permissions_tenantId_roleId_idx" ON "role_permissions"("tenantId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "users_tenantId_roleId_idx" ON "users"("tenantId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_active" ON "users"("email") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_type_idx" ON "auth_tokens"("userId", "type");

-- CreateIndex
CREATE INDEX "impersonation_sessions_tenantId_startedAt_idx" ON "impersonation_sessions"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "customers_tenantId_name_idx" ON "customers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_doc_active" ON "customers"("tenantId", "docType", "docNumber") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "vehicles_tenantId_customerId_idx" ON "vehicles"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenantId_id_key" ON "vehicles"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenantId_plate_active" ON "vehicles"("tenantId", "plate") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "maintenance_reminders_tenantId_status_dueDate_idx" ON "maintenance_reminders"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "maintenance_reminders_tenantId_vehicleId_idx" ON "maintenance_reminders"("tenantId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_reminders_tenantId_id_key" ON "maintenance_reminders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenantId_id_key" ON "product_categories"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warranty_policies_tenantId_id_key" ON "warranty_policies"("tenantId", "id");

-- CreateIndex
CREATE INDEX "products_tenantId_kind_idx" ON "products"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "products_tenantId_name_idx" ON "products"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_id_key" ON "products"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_sku_active" ON "products"("tenantId", "sku") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_barcode_active" ON "products"("tenantId", "barcode") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "tire_details_tenantId_width_aspectRatio_rimDiameter_idx" ON "tire_details"("tenantId", "width", "aspectRatio", "rimDiameter");

-- CreateIndex
CREATE UNIQUE INDEX "tire_details_tenantId_productId_key" ON "tire_details"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "battery_details_tenantId_capacityAh_ccaA_idx" ON "battery_details"("tenantId", "capacityAh", "ccaA");

-- CreateIndex
CREATE UNIQUE INDEX "battery_details_tenantId_productId_key" ON "battery_details"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "lubricant_details_tenantId_viscosity_idx" ON "lubricant_details"("tenantId", "viscosity");

-- CreateIndex
CREATE UNIQUE INDEX "lubricant_details_tenantId_productId_key" ON "lubricant_details"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "part_details_tenantId_oemCode_idx" ON "part_details"("tenantId", "oemCode");

-- CreateIndex
CREATE UNIQUE INDEX "part_details_tenantId_productId_key" ON "part_details"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "part_equivalences_tenantId_code_idx" ON "part_equivalences"("tenantId", "code");

-- CreateIndex
CREATE INDEX "part_equivalences_tenantId_productId_idx" ON "part_equivalences"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "vehicle_compatibilities_tenantId_make_model_idx" ON "vehicle_compatibilities"("tenantId", "make", "model");

-- CreateIndex
CREATE INDEX "vehicle_compatibilities_tenantId_productId_idx" ON "vehicle_compatibilities"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_name_idx" ON "suppliers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_id_key" ON "suppliers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_taxId_active" ON "suppliers"("tenantId", "taxId") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "supplier_products_tenantId_productId_idx" ON "supplier_products"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_tenantId_id_key" ON "supplier_products"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_pair_active" ON "supplier_products"("tenantId", "supplierId", "productId") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "supplier_price_history_tenantId_supplierProductId_recordedA_idx" ON "supplier_price_history"("tenantId", "supplierProductId", "recordedAt");

-- CreateIndex
CREATE INDEX "stock_lots_tenantId_manufacturedAt_idx" ON "stock_lots"("tenantId", "manufacturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_tenantId_id_key" ON "stock_lots"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_tenantId_productId_code_key" ON "stock_lots"("tenantId", "productId", "code");

-- CreateIndex
CREATE INDEX "serial_numbers_tenantId_status_idx" ON "serial_numbers"("tenantId", "status");

-- CreateIndex
CREATE INDEX "serial_numbers_tenantId_serial_idx" ON "serial_numbers"("tenantId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "serial_numbers_tenantId_id_key" ON "serial_numbers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "serial_numbers_tenantId_productId_serial_key" ON "serial_numbers"("tenantId", "productId", "serial");

-- CreateIndex
CREATE INDEX "stock_balances_tenantId_productId_idx" ON "stock_balances"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_tenantId_warehouseId_productId_key" ON "stock_balances"("tenantId", "warehouseId", "productId");

-- CreateIndex
CREATE INDEX "stock_lot_balances_tenantId_productId_idx" ON "stock_lot_balances"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lot_balances_tenantId_warehouseId_lotId_key" ON "stock_lot_balances"("tenantId", "warehouseId", "lotId");

-- CreateIndex
CREATE UNIQUE INDEX "reorder_policies_tenantId_warehouseId_productId_key" ON "reorder_policies"("tenantId", "warehouseId", "productId");

-- CreateIndex
CREATE INDEX "kardex_movements_tenantId_productId_warehouseId_occurredAt_idx" ON "kardex_movements"("tenantId", "productId", "warehouseId", "occurredAt");

-- CreateIndex
CREATE INDEX "kardex_movements_tenantId_referenceType_referenceId_idx" ON "kardex_movements"("tenantId", "referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "kardex_movements_tenantId_occurredAt_idx" ON "kardex_movements"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "kardex_movements_tenantId_id_key" ON "kardex_movements"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kardex_movements_tenantId_idempotencyKey_key" ON "kardex_movements"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "stock_transfers_tenantId_status_idx" ON "stock_transfers"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenantId_id_key" ON "stock_transfers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenantId_number_key" ON "stock_transfers"("tenantId", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_items_tenantId_transferId_idx" ON "stock_transfer_items"("tenantId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_counts_tenantId_id_key" ON "inventory_counts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_counts_tenantId_number_key" ON "inventory_counts"("tenantId", "number");

-- CreateIndex
CREATE INDEX "inventory_count_items_tenantId_countId_idx" ON "inventory_count_items"("tenantId", "countId");

-- CreateIndex
CREATE INDEX "purchase_orders_tenantId_status_idx" ON "purchase_orders"("tenantId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_tenantId_supplierId_idx" ON "purchase_orders"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenantId_id_key" ON "purchase_orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenantId_number_key" ON "purchase_orders"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenantId_idempotencyKey_key" ON "purchase_orders"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_order_items_tenantId_orderId_idx" ON "purchase_order_items"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_tenantId_id_key" ON "purchase_order_items"("tenantId", "id");

-- CreateIndex
CREATE INDEX "purchase_receipts_tenantId_orderId_idx" ON "purchase_receipts"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_tenantId_id_key" ON "purchase_receipts"("tenantId", "id");

-- CreateIndex
CREATE INDEX "purchase_receipt_items_tenantId_receiptId_idx" ON "purchase_receipt_items"("tenantId", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_tenantId_id_key" ON "supplier_returns"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_tenantId_number_key" ON "supplier_returns"("tenantId", "number");

-- CreateIndex
CREATE INDEX "supplier_return_items_tenantId_returnId_idx" ON "supplier_return_items"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "supplier_messages_tenantId_supplierId_createdAt_idx" ON "supplier_messages"("tenantId", "supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_messages_tenantId_orderId_idx" ON "supplier_messages"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_messages_tenantId_channel_externalId_key" ON "supplier_messages"("tenantId", "channel", "externalId");

-- CreateIndex
CREATE INDEX "ai_runs_tenantId_startedAt_idx" ON "ai_runs"("tenantId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_tenantId_id_key" ON "ai_runs"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_tenantId_idempotencyKey_key" ON "ai_runs"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_order_drafts_tenantId_status_idx" ON "ai_order_drafts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_order_drafts_tenantId_id_key" ON "ai_order_drafts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_order_drafts_tenantId_idempotencyKey_key" ON "ai_order_drafts"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_order_draft_items_tenantId_draftId_idx" ON "ai_order_draft_items"("tenantId", "draftId");

-- CreateIndex
CREATE INDEX "work_orders_tenantId_status_idx" ON "work_orders"("tenantId", "status");

-- CreateIndex
CREATE INDEX "work_orders_tenantId_vehicleId_idx" ON "work_orders"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "work_orders_tenantId_assignedMechanicId_status_idx" ON "work_orders"("tenantId", "assignedMechanicId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_tenantId_id_key" ON "work_orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_tenantId_number_key" ON "work_orders"("tenantId", "number");

-- CreateIndex
CREATE INDEX "work_order_items_tenantId_workOrderId_idx" ON "work_order_items"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "work_order_items_tenantId_partStatus_idx" ON "work_order_items"("tenantId", "partStatus");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_items_tenantId_id_key" ON "work_order_items"("tenantId", "id");

-- CreateIndex
CREATE INDEX "work_order_checklist_items_tenantId_workOrderId_idx" ON "work_order_checklist_items"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "work_order_photos_tenantId_workOrderId_idx" ON "work_order_photos"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "work_order_status_history_tenantId_workOrderId_changedAt_idx" ON "work_order_status_history"("tenantId", "workOrderId", "changedAt");

-- CreateIndex
CREATE INDEX "quotes_tenantId_status_idx" ON "quotes"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenantId_id_key" ON "quotes"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenantId_number_key" ON "quotes"("tenantId", "number");

-- CreateIndex
CREATE INDEX "quote_items_tenantId_quoteId_idx" ON "quote_items"("tenantId", "quoteId");

-- CreateIndex
CREATE INDEX "cash_sessions_tenantId_branchId_status_idx" ON "cash_sessions"("tenantId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_tenantId_id_key" ON "cash_sessions"("tenantId", "id");

-- CreateIndex
CREATE INDEX "cash_movements_tenantId_sessionId_idx" ON "cash_movements"("tenantId", "sessionId");

-- CreateIndex
CREATE INDEX "sales_tenantId_status_createdAt_idx" ON "sales"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "sales_tenantId_customerId_idx" ON "sales"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_id_key" ON "sales"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_number_key" ON "sales"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_idempotencyKey_key" ON "sales"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sale_items_tenantId_saleId_idx" ON "sale_items"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "sale_items_tenantId_productId_idx" ON "sale_items"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_tenantId_id_key" ON "sale_items"("tenantId", "id");

-- CreateIndex
CREATE INDEX "sale_payments_tenantId_saleId_idx" ON "sale_payments"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "sale_payments_tenantId_cashSessionId_idx" ON "sale_payments"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "receivables_tenantId_status_dueDate_idx" ON "receivables"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "receivables_tenantId_customerId_idx" ON "receivables"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "receivables_tenantId_saleId_key" ON "receivables"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "sale_returns_tenantId_saleId_idx" ON "sale_returns"("tenantId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_id_key" ON "sale_returns"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_number_key" ON "sale_returns"("tenantId", "number");

-- CreateIndex
CREATE INDEX "sale_return_items_tenantId_returnId_idx" ON "sale_return_items"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "fiscal_documents_tenantId_status_nextRetryAt_idx" ON "fiscal_documents"("tenantId", "status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_tenantId_id_key" ON "fiscal_documents"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_tenantId_type_series_correlative_key" ON "fiscal_documents"("tenantId", "type", "series", "correlative");

-- CreateIndex
CREATE INDEX "warranties_tenantId_status_expiresAt_idx" ON "warranties"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "warranties_tenantId_customerId_idx" ON "warranties"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "warranties_tenantId_vehicleId_idx" ON "warranties"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "warranties_tenantId_serialId_idx" ON "warranties"("tenantId", "serialId");

-- CreateIndex
CREATE UNIQUE INDEX "warranties_tenantId_id_key" ON "warranties"("tenantId", "id");

-- CreateIndex
CREATE INDEX "warranty_claims_tenantId_status_idx" ON "warranty_claims"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warranty_claims_tenantId_id_key" ON "warranty_claims"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warranty_claims_tenantId_number_key" ON "warranty_claims"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequences_tenantId_docType_series_key" ON "document_sequences"("tenantId", "docType", "series");

-- CreateIndex
CREATE INDEX "notifications_tenantId_userId_readAt_idx" ON "notifications"("tenantId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenantId_dedupeKey_key" ON "notifications"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "outbound_messages_tenantId_status_scheduledAt_idx" ON "outbound_messages"("tenantId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_tenantId_idempotencyKey_key" ON "outbound_messages"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_occurredAt_idx" ON "audit_logs"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entityType_entityId_idx" ON "audit_logs"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_actorUserId_idx" ON "audit_logs"("tenantId", "actorUserId");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_tenantId_subscriptionId_fkey" FOREIGN KEY ("tenantId", "subscriptionId") REFERENCES "subscriptions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_defaultBranchId_fkey" FOREIGN KEY ("tenantId", "defaultBranchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_superAdminUserId_fkey" FOREIGN KEY ("superAdminUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_reminders" ADD CONSTRAINT "maintenance_reminders_tenantId_vehicleId_fkey" FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "vehicles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenantId_parentId_fkey" FOREIGN KEY ("tenantId", "parentId") REFERENCES "product_categories"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_policies" ADD CONSTRAINT "warranty_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "product_categories"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_warrantyPolicyId_fkey" FOREIGN KEY ("tenantId", "warrantyPolicyId") REFERENCES "warranty_policies"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_details" ADD CONSTRAINT "tire_details_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battery_details" ADD CONSTRAINT "battery_details_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lubricant_details" ADD CONSTRAINT "lubricant_details_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_details" ADD CONSTRAINT "part_details_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_equivalences" ADD CONSTRAINT "part_equivalences_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_compatibilities" ADD CONSTRAINT "vehicle_compatibilities_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_price_history" ADD CONSTRAINT "supplier_price_history_tenantId_supplierProductId_fkey" FOREIGN KEY ("tenantId", "supplierProductId") REFERENCES "supplier_products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lot_balances" ADD CONSTRAINT "stock_lot_balances_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lot_balances" ADD CONSTRAINT "stock_lot_balances_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lot_balances" ADD CONSTRAINT "stock_lot_balances_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_policies" ADD CONSTRAINT "reorder_policies_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_policies" ADD CONSTRAINT "reorder_policies_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kardex_movements" ADD CONSTRAINT "kardex_movements_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kardex_movements" ADD CONSTRAINT "kardex_movements_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kardex_movements" ADD CONSTRAINT "kardex_movements_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kardex_movements" ADD CONSTRAINT "kardex_movements_tenantId_serialId_fkey" FOREIGN KEY ("tenantId", "serialId") REFERENCES "serial_numbers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenantId_fromWarehouseId_fkey" FOREIGN KEY ("tenantId", "fromWarehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenantId_toWarehouseId_fkey" FOREIGN KEY ("tenantId", "toWarehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "stock_transfers"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_tenantId_serialId_fkey" FOREIGN KEY ("tenantId", "serialId") REFERENCES "serial_numbers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_countId_fkey" FOREIGN KEY ("tenantId", "countId") REFERENCES "inventory_counts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenantId_aiRunId_fkey" FOREIGN KEY ("tenantId", "aiRunId") REFERENCES "ai_runs"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_tenantId_receiptId_fkey" FOREIGN KEY ("tenantId", "receiptId") REFERENCES "purchase_receipts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_tenantId_orderItemId_fkey" FOREIGN KEY ("tenantId", "orderItemId") REFERENCES "purchase_order_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_tenantId_serialId_fkey" FOREIGN KEY ("tenantId", "serialId") REFERENCES "serial_numbers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "supplier_returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_messages" ADD CONSTRAINT "supplier_messages_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_messages" ADD CONSTRAINT "supplier_messages_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_order_drafts" ADD CONSTRAINT "ai_order_drafts_tenantId_aiRunId_fkey" FOREIGN KEY ("tenantId", "aiRunId") REFERENCES "ai_runs"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_order_drafts" ADD CONSTRAINT "ai_order_drafts_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_order_drafts" ADD CONSTRAINT "ai_order_drafts_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_order_draft_items" ADD CONSTRAINT "ai_order_draft_items_tenantId_draftId_fkey" FOREIGN KEY ("tenantId", "draftId") REFERENCES "ai_order_drafts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_order_draft_items" ADD CONSTRAINT "ai_order_draft_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tenantId_vehicleId_fkey" FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "vehicles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tenantId_assignedMechanicId_fkey" FOREIGN KEY ("tenantId", "assignedMechanicId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tenantId_quoteId_fkey" FOREIGN KEY ("tenantId", "quoteId") REFERENCES "quotes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_tenantId_workOrderId_fkey" FOREIGN KEY ("tenantId", "workOrderId") REFERENCES "work_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_tenantId_mechanicId_fkey" FOREIGN KEY ("tenantId", "mechanicId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_checklist_items" ADD CONSTRAINT "work_order_checklist_items_tenantId_workOrderId_fkey" FOREIGN KEY ("tenantId", "workOrderId") REFERENCES "work_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_photos" ADD CONSTRAINT "work_order_photos_tenantId_workOrderId_fkey" FOREIGN KEY ("tenantId", "workOrderId") REFERENCES "work_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_status_history" ADD CONSTRAINT "work_order_status_history_tenantId_workOrderId_fkey" FOREIGN KEY ("tenantId", "workOrderId") REFERENCES "work_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenantId_vehicleId_fkey" FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "vehicles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_tenantId_quoteId_fkey" FOREIGN KEY ("tenantId", "quoteId") REFERENCES "quotes"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_openedById_fkey" FOREIGN KEY ("tenantId", "openedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_vehicleId_fkey" FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "vehicles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_workOrderId_fkey" FOREIGN KEY ("tenantId", "workOrderId") REFERENCES "work_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_quoteId_fkey" FOREIGN KEY ("tenantId", "quoteId") REFERENCES "quotes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_sellerId_fkey" FOREIGN KEY ("tenantId", "sellerId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenantId_serialId_fkey" FOREIGN KEY ("tenantId", "serialId") REFERENCES "serial_numbers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "sale_returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenantId_saleItemId_fkey" FOREIGN KEY ("tenantId", "saleItemId") REFERENCES "sale_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_tenantId_relatedDocumentId_fkey" FOREIGN KEY ("tenantId", "relatedDocumentId") REFERENCES "fiscal_documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_vehicleId_fkey" FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "vehicles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_policyId_fkey" FOREIGN KEY ("tenantId", "policyId") REFERENCES "warranty_policies"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_saleItemId_fkey" FOREIGN KEY ("tenantId", "saleItemId") REFERENCES "sale_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_workOrderItemId_fkey" FOREIGN KEY ("tenantId", "workOrderItemId") REFERENCES "work_order_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_serialId_fkey" FOREIGN KEY ("tenantId", "serialId") REFERENCES "serial_numbers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_tenantId_lotId_fkey" FOREIGN KEY ("tenantId", "lotId") REFERENCES "stock_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_tenantId_warrantyId_fkey" FOREIGN KEY ("tenantId", "warrantyId") REFERENCES "warranties"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
