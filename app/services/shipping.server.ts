import crypto from "node:crypto";

// Return-label providers. EasyPost is used when EASYPOST_API_KEY is set;
// otherwise a sandbox provider issues a printable PDF label served by this app
// (see app/routes/labels.$token[.pdf].tsx) so the full flow works in development.

export type Address = {
  name: string;
  street1: string;
  street2?: string | null;
  city: string;
  state?: string | null;
  zip: string;
  country: string;
  phone?: string | null;
  email?: string | null;
};

export type ReturnLabel = {
  carrier: string;
  trackingNumber: string;
  trackingUrl: string;
  labelUrl: string;
  labelToken: string;
  cost: number;
};

export interface LabelProvider {
  name: string;
  createReturnLabel(input: {
    from: Address;
    to: Address;
    weightOz: number;
    reference: string;
  }): Promise<ReturnLabel>;
}

const appUrl = () => (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

class SandboxLabelProvider implements LabelProvider {
  name = "Sandbox";

  async createReturnLabel() {
    const labelToken = crypto.randomBytes(16).toString("hex");
    const trackingNumber = `RMA${Date.now().toString().slice(-9)}${crypto
      .randomInt(100, 999)
      .toString()}`;
    return {
      carrier: "USPS (sandbox)",
      trackingNumber,
      trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
      labelUrl: `${appUrl()}/labels/${labelToken}.pdf`,
      labelToken,
      cost: 0,
    };
  }
}

class EasyPostLabelProvider implements LabelProvider {
  name = "EasyPost";

  constructor(private apiKey: string) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.easypost.com/v2${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(
        `EasyPost: ${json?.error?.message ?? response.statusText}`,
      );
    }
    return json as T;
  }

  async createReturnLabel({
    from,
    to,
    weightOz,
    reference,
  }: Parameters<LabelProvider["createReturnLabel"]>[0]) {
    type Shipment = {
      id: string;
      rates: { id: string; rate: string; carrier: string }[];
    };
    const shipment = await this.request<Shipment>("/shipments", {
      shipment: {
        // EasyPost return shipments keep the store as "to" and swap origin internally.
        is_return: true,
        to_address: to,
        from_address: from,
        parcel: { weight: Math.max(weightOz, 1) },
        reference,
      },
    });
    const cheapest = [...shipment.rates].sort(
      (a, b) => Number(a.rate) - Number(b.rate),
    )[0];
    if (!cheapest)
      throw new Error("EasyPost returned no rates for this return");

    const bought = await this.request<{
      tracking_code: string;
      tracker?: { public_url?: string };
      postage_label: { label_url: string };
      selected_rate: { rate: string; carrier: string };
    }>(`/shipments/${shipment.id}/buy`, { rate: { id: cheapest.id } });

    return {
      carrier: bought.selected_rate.carrier,
      trackingNumber: bought.tracking_code,
      trackingUrl: bought.tracker?.public_url ?? "",
      labelUrl: bought.postage_label.label_url,
      labelToken: crypto.randomBytes(16).toString("hex"),
      cost: Number(bought.selected_rate.rate),
    };
  }
}

export function getLabelProvider(): LabelProvider {
  const key = process.env.EASYPOST_API_KEY;
  return key ? new EasyPostLabelProvider(key) : new SandboxLabelProvider();
}

/** Minimal single-page PDF (no dependencies) used for sandbox labels. */
export function renderLabelPdf(lines: { text: string; size?: number }[]) {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  let y = 710;
  const content = [
    "2 w 36 36 540 720 re S",
    "BT",
    ...lines.flatMap(({ text, size = 12 }) => {
      const out = [
        `/F1 ${size} Tf`,
        `1 0 0 1 60 ${y} Tm`,
        `(${escape(text)}) Tj`,
      ];
      y -= size + 14;
      return out;
    }),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
