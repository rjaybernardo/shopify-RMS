import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Thin, typed wrappers around the Admin GraphQL Returns API (2026-07).
// Every operation here was validated against the Admin schema.

type Admin = Pick<AdminApiContext, "graphql">;

type UserError = { field?: string[] | null; message: string; code?: string };

export class ShopifyUserError extends Error {
  constructor(public errors: UserError[]) {
    super(errors.map((e) => e.message).join("; "));
  }
}

async function run<T>(
  admin: Admin,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data as T;
}

function assertNoUserErrors(errors: UserError[] | undefined) {
  if (errors?.length) throw new ShopifyUserError(errors);
}

export type ShopifyOrder = {
  id: string;
  name: string;
  email: string | null;
  processedAt: string;
  currencyCode: string;
  customer: { id: string; displayName: string } | null;
};

export async function findOrderByName(admin: Admin, orderName: string) {
  const name = orderName.trim().replace(/^#?/, "#");
  const data = await run<{ orders: { nodes: ShopifyOrder[] } }>(
    admin,
    `#graphql
    query RmaFindOrder($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          id
          name
          email
          processedAt
          customer { id displayName }
          currencyCode
        }
      }
    }`,
    { query: `name:${JSON.stringify(name)}` },
  );
  return data.orders.nodes[0] ?? null;
}

export type ReturnableItem = {
  fulfillmentLineItemId: string;
  quantity: number;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  currencyCode: string;
};

export type ReturnReason = { id: string; handle: string; name: string };

export async function getReturnableItems(admin: Admin, orderId: string) {
  const data = await run<{
    returnableFulfillments: {
      nodes: {
        returnableFulfillmentLineItems: {
          nodes: {
            quantity: number;
            fulfillmentLineItem: {
              id: string;
              lineItem: {
                title: string;
                variantTitle: string | null;
                sku: string | null;
                image: { url: string } | null;
                discountedUnitPriceAfterAllDiscountsSet: {
                  shopMoney: { amount: string; currencyCode: string };
                };
              };
            };
          }[];
        };
      }[];
    };
    returnReasonDefinitions: { nodes: ReturnReason[] };
  }>(
    admin,
    `#graphql
    query RmaReturnableItems($orderId: ID!) {
      returnableFulfillments(orderId: $orderId, first: 10) {
        nodes {
          id
          returnableFulfillmentLineItems(first: 50) {
            nodes {
              quantity
              fulfillmentLineItem {
                id
                lineItem {
                  id
                  title
                  variantTitle
                  sku
                  image { url altText }
                  discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
      }
      returnReasonDefinitions(first: 50, query: "deleted:false") {
        nodes { id handle name }
      }
    }`,
    { orderId },
  );

  const items: ReturnableItem[] = data.returnableFulfillments.nodes.flatMap(
    (fulfillment) =>
      fulfillment.returnableFulfillmentLineItems.nodes
        .filter((node) => node.quantity > 0)
        .map(({ quantity, fulfillmentLineItem: { id, lineItem } }) => ({
          fulfillmentLineItemId: id,
          quantity,
          title: lineItem.title,
          variantTitle: lineItem.variantTitle,
          sku: lineItem.sku,
          imageUrl: lineItem.image?.url ?? null,
          unitPrice: Number(
            lineItem.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount,
          ),
          currencyCode:
            lineItem.discountedUnitPriceAfterAllDiscountsSet.shopMoney
              .currencyCode,
        })),
  );

  return { items, reasons: data.returnReasonDefinitions.nodes };
}

export async function requestReturn(
  admin: Admin,
  orderId: string,
  lineItems: {
    fulfillmentLineItemId: string;
    quantity: number;
    returnReasonDefinitionId: string;
    customerNote?: string;
  }[],
) {
  const data = await run<{
    returnRequest: {
      return: { id: string; name: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation RmaReturnRequest($input: ReturnRequestInput!) {
      returnRequest(input: $input) {
        return { id name status }
        userErrors { field message code }
      }
    }`,
    { input: { orderId, returnLineItems: lineItems } },
  );
  assertNoUserErrors(data.returnRequest.userErrors);
  return data.returnRequest.return!;
}

export async function approveReturn(admin: Admin, returnId: string) {
  const data = await run<{
    returnApproveRequest: {
      return: {
        id: string;
        status: string;
        reverseFulfillmentOrders: { nodes: { id: string }[] };
      } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation RmaApproveReturn($input: ReturnApproveRequestInput!) {
      returnApproveRequest(input: $input) {
        return {
          id
          status
          reverseFulfillmentOrders(first: 5) { nodes { id } }
        }
        userErrors { field message code }
      }
    }`,
    { input: { id: returnId } },
  );
  assertNoUserErrors(data.returnApproveRequest.userErrors);
  return data.returnApproveRequest.return!;
}

export const DECLINE_REASONS = [
  "RETURN_PERIOD_ENDED",
  "FINAL_SALE",
  "OTHER",
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export async function declineReturn(
  admin: Admin,
  returnId: string,
  declineReason: DeclineReason,
  declineNote?: string,
) {
  const data = await run<{
    returnDeclineRequest: {
      return: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation RmaDeclineReturn($input: ReturnDeclineRequestInput!) {
      returnDeclineRequest(input: $input) {
        return { id status }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        id: returnId,
        declineReason,
        ...(declineNote ? { declineNote: declineNote.slice(0, 500) } : {}),
      },
    },
  );
  assertNoUserErrors(data.returnDeclineRequest.userErrors);
  return data.returnDeclineRequest.return!;
}

/** Attaches the carrier label + tracking to every reverse fulfillment order of the return. */
export async function attachReturnLabel(
  admin: Admin,
  reverseFulfillmentOrderIds: string[],
  label: { labelUrl: string; trackingNumber: string; trackingUrl: string },
) {
  for (const reverseFulfillmentOrderId of reverseFulfillmentOrderIds) {
    const data = await run<{
      reverseDeliveryCreateWithShipping: {
        reverseDelivery: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      admin,
      `#graphql
      mutation RmaCreateReverseDelivery($reverseFulfillmentOrderId: ID!, $trackingInput: ReverseDeliveryTrackingInput, $labelInput: ReverseDeliveryLabelInput) {
        reverseDeliveryCreateWithShipping(
          reverseFulfillmentOrderId: $reverseFulfillmentOrderId
          reverseDeliveryLineItems: []
          trackingInput: $trackingInput
          labelInput: $labelInput
          notifyCustomer: false
        ) {
          reverseDelivery { id }
          userErrors { field message code }
        }
      }`,
      {
        reverseFulfillmentOrderId,
        trackingInput: {
          number: label.trackingNumber,
          url: label.trackingUrl,
        },
        labelInput: { fileUrl: label.labelUrl },
      },
    );
    assertNoUserErrors(data.reverseDeliveryCreateWithShipping.userErrors);
  }
}

type MailingAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  zip: string | null;
  countryCodeV2: string | null;
  phone: string | null;
};

export async function getLabelAddresses(admin: Admin, orderId: string) {
  const data = await run<{
    order: {
      shippingAddress: (MailingAddress & { name: string | null }) | null;
    };
    shop: { name: string; email: string; shopAddress: MailingAddress };
  }>(
    admin,
    `#graphql
    query RmaLabelAddresses($orderId: ID!) {
      order(id: $orderId) {
        shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone }
      }
      shop {
        name
        email
        shopAddress { address1 address2 city provinceCode zip countryCodeV2 phone }
      }
    }`,
    { orderId },
  );

  const toAddress = (
    a: MailingAddress | null,
    name: string,
    email?: string,
  ) => ({
    name,
    street1: a?.address1 ?? "",
    street2: a?.address2,
    city: a?.city ?? "",
    state: a?.provinceCode,
    zip: a?.zip ?? "",
    country: a?.countryCodeV2 ?? "US",
    phone: a?.phone,
    email,
  });

  return {
    customer: toAddress(
      data.order.shippingAddress,
      data.order.shippingAddress?.name ?? "Customer",
    ),
    store: toAddress(data.shop.shopAddress, data.shop.name, data.shop.email),
  };
}

type ReturnForProcessing = {
  id: string;
  status: string;
  returnLineItems: {
    nodes: {
      id: string;
      quantity?: number;
      processableQuantity?: number;
      fulfillmentLineItem?: { id: string };
    }[];
  };
  reverseFulfillmentOrders: {
    nodes: {
      id: string;
      lineItems: {
        nodes: {
          id: string;
          totalQuantity: number;
          fulfillmentLineItem: { id: string } | null;
        }[];
      };
    }[];
  };
};

export async function getReturnForProcessing(admin: Admin, returnId: string) {
  const data = await run<{
    return: ReturnForProcessing | null;
    locations: { nodes: { id: string }[] };
  }>(
    admin,
    `#graphql
    query RmaReturnForProcessing($id: ID!) {
      return(id: $id) {
        id
        status
        returnLineItems(first: 50) {
          nodes {
            id
            ... on ReturnLineItem {
              quantity
              processableQuantity
              fulfillmentLineItem { id }
            }
          }
        }
        reverseFulfillmentOrders(first: 5) {
          nodes {
            id
            lineItems(first: 50) {
              nodes {
                id
                totalQuantity
                fulfillmentLineItem { id }
              }
            }
          }
        }
      }
      locations(first: 1, query: "active:true") { nodes { id } }
    }`,
    { id: returnId },
  );
  if (!data.return) throw new Error(`Return ${returnId} not found`);
  return {
    shopifyReturn: data.return,
    defaultLocationId: data.locations.nodes[0]?.id ?? null,
  };
}

/**
 * Receives the items (optionally restocking them) and refunds the original
 * payment methods using Shopify's suggested financial outcome.
 */
export async function processReturnWithRefund(
  admin: Admin,
  returnId: string,
  { restock }: { restock: boolean },
) {
  const { shopifyReturn, defaultLocationId } = await getReturnForProcessing(
    admin,
    returnId,
  );

  const processable = shopifyReturn.returnLineItems.nodes.filter(
    (item) => (item.processableQuantity ?? 0) > 0,
  );
  if (!processable.length) {
    throw new Error("This return has no items left to process.");
  }

  const rfoLineItems = shopifyReturn.reverseFulfillmentOrders.nodes.flatMap(
    (rfo) => rfo.lineItems.nodes,
  );

  const suggestion = await run<{
    return: {
      suggestedFinancialOutcome: {
        financialTransfer: {
          suggestedTransactions?: {
            amountSet: {
              presentmentMoney: { amount: string; currencyCode: string };
            };
            parentTransaction: { id: string } | null;
          }[];
        } | null;
      };
    };
  }>(
    admin,
    `#graphql
    query RmaSuggestedRefund($id: ID!, $returnLineItems: [SuggestedOutcomeReturnLineItemInput!]!) {
      return(id: $id) {
        suggestedFinancialOutcome(returnLineItems: $returnLineItems, exchangeLineItems: [], refundMethodAllocation: ORIGINAL_PAYMENT_METHODS) {
          financialTransfer {
            ... on RefundReturnOutcome {
              suggestedTransactions {
                amountSet { presentmentMoney { amount currencyCode } }
                parentTransaction { id }
              }
            }
          }
        }
      }
    }`,
    {
      id: returnId,
      returnLineItems: processable.map((item) => ({
        id: item.id,
        quantity: item.processableQuantity,
      })),
    },
  );

  const transactions = (
    suggestion.return.suggestedFinancialOutcome.financialTransfer
      ?.suggestedTransactions ?? []
  ).filter(
    (t) =>
      t.parentTransaction && Number(t.amountSet.presentmentMoney.amount) > 0,
  );

  const refundAmount = transactions.reduce(
    (sum, t) => sum + Number(t.amountSet.presentmentMoney.amount),
    0,
  );
  const currencyCode = transactions[0]?.amountSet.presentmentMoney.currencyCode;

  const returnLineItems = processable.map((item) => {
    const rfoLineItem = rfoLineItems.find(
      (li) => li.fulfillmentLineItem?.id === item.fulfillmentLineItem?.id,
    );
    const dispositions =
      rfoLineItem && (restock ? defaultLocationId : true)
        ? [
            {
              reverseFulfillmentOrderLineItemId: rfoLineItem.id,
              quantity: item.processableQuantity!,
              dispositionType: restock ? "RESTOCKED" : "NOT_RESTOCKED",
              ...(restock ? { locationId: defaultLocationId } : {}),
            },
          ]
        : undefined;
    return {
      id: item.id,
      quantity: item.processableQuantity!,
      ...(dispositions ? { dispositions } : {}),
    };
  });

  const data = await run<{
    returnProcess: {
      return: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation RmaProcessReturn($input: ReturnProcessInput!) {
      returnProcess(input: $input) {
        return { id status }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        returnId,
        returnLineItems,
        notifyCustomer: true,
        ...(transactions.length
          ? {
              financialTransfer: {
                issueRefund: {
                  orderTransactions: transactions.map((t) => ({
                    parentId: t.parentTransaction!.id,
                    transactionAmount: {
                      amount: t.amountSet.presentmentMoney.amount,
                      currencyCode: t.amountSet.presentmentMoney.currencyCode,
                    },
                  })),
                },
              },
            }
          : {}),
      },
    },
  );
  assertNoUserErrors(data.returnProcess.userErrors);

  return {
    status: data.returnProcess.return!.status,
    refundAmount,
    currencyCode,
  };
}
