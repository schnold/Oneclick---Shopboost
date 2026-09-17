-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "domain" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "activeBoostId" TEXT,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "audit_snapshots" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "boostScore" INTEGER NOT NULL,
    "imageScore" INTEGER NOT NULL,
    "seoScore" INTEGER NOT NULL,
    "geoScore" INTEGER NOT NULL,
    "speedScore" INTEGER NOT NULL,
    "totals" JSONB NOT NULL,
    "boostId" TEXT,

    CONSTRAINT "audit_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boosts" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "settings" JSONB NOT NULL,

    CONSTRAINT "boosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optimization_jobs" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "boostId" TEXT,
    "module" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "label" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "optimization_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optimization_items" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "savedBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "optimization_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_snapshots_shopDomain_createdAt_idx" ON "audit_snapshots"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "boosts_shopDomain_createdAt_idx" ON "boosts"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "optimization_jobs_shopDomain_createdAt_idx" ON "optimization_jobs"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "optimization_jobs_boostId_idx" ON "optimization_jobs"("boostId");

-- CreateIndex
CREATE INDEX "optimization_items_jobId_idx" ON "optimization_items"("jobId");

-- CreateIndex
CREATE INDEX "optimization_items_resourceId_idx" ON "optimization_items"("resourceId");

-- AddForeignKey
ALTER TABLE "audit_snapshots" ADD CONSTRAINT "audit_snapshots_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "shops"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_jobs" ADD CONSTRAINT "optimization_jobs_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "shops"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_jobs" ADD CONSTRAINT "optimization_jobs_boostId_fkey" FOREIGN KEY ("boostId") REFERENCES "boosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_items" ADD CONSTRAINT "optimization_items_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "optimization_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
