-- Additive webhook endpoint management; delivery state arrives separately.
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "filterQuery" TEXT NOT NULL DEFAULT '',
    "scopeTenantId" TEXT,
    "scopeTargetType" TEXT,
    "scopeTargetId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookEndpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WebhookEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "WebhookSecret" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "WebhookSecret_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookSecret_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WebhookEndpoint_projectId_idx" ON "WebhookEndpoint"("projectId");
CREATE INDEX "WebhookSecret_endpointId_idx" ON "WebhookSecret"("endpointId");
