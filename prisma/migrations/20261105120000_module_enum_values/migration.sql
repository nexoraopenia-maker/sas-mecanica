-- Nuevos módulos comerciales. Se agregan en una migración aparte: PostgreSQL no permite USAR un valor de enum
-- en la misma transacción en que se crea (lo usa la migración siguiente).
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'ACCOUNTING';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'BRANCHES';
