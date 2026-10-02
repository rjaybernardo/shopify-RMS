-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "autoRefundOnReceipt" BOOLEAN NOT NULL DEFAULT true,
    "restockOnReceipt" BOOLEAN NOT NULL DEFAULT true,
    "notifyMerchantEmail" TEXT,
    "portalIntro" TEXT NOT NULL DEFAULT 'Start a return in a few clicks. You''ll need your order number and the email used at checkout.',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyReturnId" TEXT,
    "returnName" TEXT,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "source" TEXT NOT NULL DEFAULT 'PORTAL',
    "customerNote" TEXT,
    "declineReason" TEXT,
    "declineNote" TEXT,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "labelUrl" TEXT,
    "labelToken" TEXT,
    "labelCost" REAL,
    "refundAmount" REAL,
    "currencyCode" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "labelSentAt" DATETIME,
    "receivedAt" DATETIME,
    "refundedAt" DATETIME,
    "closedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReturnLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnRequestId" TEXT NOT NULL,
    "fulfillmentLineItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "reasonHandle" TEXT NOT NULL,
    "reasonName" TEXT NOT NULL,
    "customerNote" TEXT,
    CONSTRAINT "ReturnLineItem_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReturnEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnRequestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReturnEvent_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_shopifyReturnId_key" ON "ReturnRequest"("shopifyReturnId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_labelToken_key" ON "ReturnRequest"("labelToken");

-- CreateIndex
CREATE INDEX "ReturnRequest_shop_status_idx" ON "ReturnRequest"("shop", "status");

-- CreateIndex
CREATE INDEX "ReturnRequest_shop_requestedAt_idx" ON "ReturnRequest"("shop", "requestedAt");
