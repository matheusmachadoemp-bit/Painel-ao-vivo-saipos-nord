const SAIPOS_BASE_URL = "https://data.saipos.io/v1";
const TIME_ZONE = "America/Sao_Paulo";

type AnyRecord = Record<string, any>;

type NormalizedOrder = {
  id: string;
  number: string;
  createdAt: string;
  updatedAt: string;
  kdsEnteredAt: string;
  kdsFinishedAt: string | null;
  status: string;
  statusKind: "production" | "ready" | "completed" | "cancelled" | "unknown";
  finishedAt: string | null;
  channel: string;
  platform: string;
  customerName: string;
  district: string;
  cancelled: boolean;
  totalAmount: number;
};

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function authHeader(token: string) {
  const scheme = (process.env.SAIPOS_AUTH_SCHEME || "Bearer").trim().toLowerCase();
  return scheme === "raw" ? token : `Bearer ${token}`;
}

async function saiposGet(path: string, params: Record<string, string>) {
  const token = process.env.SAIPOS_API_TOKEN?.trim();
  if (!token) throw new Error("SAIPOS_API_TOKEN não configurado no servidor.");

  const url = new URL(`${SAIPOS_BASE_URL}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: authHeader(token),
      },
    });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      const detail = typeof data === "string" ? data : data?.message || data?.error || JSON.stringify(data);
      throw new Error(`Saipos HTTP ${response.status}: ${detail || "falha na consulta"}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function rowsFrom(payload: any): AnyRecord[] {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "results", "rows", "items", "sales"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function statusKind(status: string, cancelled: boolean): NormalizedOrder["statusKind"] {
  if (cancelled) return "cancelled";
  const s = status.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/pront|aguardando retirada|aguardando entregador/.test(s)) return "ready";
  if (/finaliz|conclu|entreg|fechad/.test(s)) return "completed";
  if (/produ|prepar|cozinha|aceit|recebid|novo|abert/.test(s)) return "production";
  return "unknown";
}

function latestHistory(histories: AnyRecord[]) {
  return [...histories].sort((a, b) => {
    const orderDiff = Number(a.order || 0) - Number(b.order || 0);
    if (orderDiff) return orderDiff;
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  }).at(-1);
}

function firstProductionTime(histories: AnyRecord[], fallback: string) {
  const row = histories.find((h) => {
    const s = String(h.desc_store_sale_status || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return /produ|prepar|cozinha|aceit|recebid|novo/.test(s);
  });
  return row?.created_at || fallback;
}

function finalTime(histories: AnyRecord[]) {
  const row = [...histories].reverse().find((h) => {
    const s = String(h.desc_store_sale_status || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return /finaliz|conclu|entreg|fechad|pront/.test(s);
  });
  return row?.created_at || null;
}

function displayNumber(sale: AnyRecord) {
  return String(
    sale?.partner_sale?.cod_sale2 ||
    sale?.sale_number ||
    sale?.ticket?.number ||
    sale?.desc_sale ||
    sale?.id_sale ||
    "—"
  );
}

function channelName(sale: AnyRecord) {
  switch (Number(sale.id_sale_type)) {
    case 1: return "Delivery";
    case 2: return "Retirada";
    case 3: return "Salão";
    case 4: return "Ficha";
    default: return "Saipos";
  }
}

function platformName(sale: AnyRecord) {
  return String(
    sale?.partner_sale?.desc_store_partner ||
    sale?.partner_sale?.desc_partner ||
    sale?.partner_sale?.partner_name ||
    "Saipos"
  );
}

export async function GET() {
  const syncedAt = new Date().toISOString();
  const day = localDateParts();
  const params = {
    p_date_column_filter: "shift_date",
    p_filter_date_start: `${day}T00:00:00`,
    p_filter_date_end: `${day}T23:59:59`,
    p_limit: "1000",
    p_offset: "0",
  };

  try {
    const [salesPayload, historyPayload] = await Promise.all([
      saiposGet("/search_sales", params),
      saiposGet("/sales_status_histories", params),
    ]);

    const storeId = process.env.SAIPOS_STORE_ID?.trim();
    const sales = rowsFrom(salesPayload).filter((sale) => !storeId || String(sale.id_store) === storeId);
    const historyRows = rowsFrom(historyPayload).filter((row) => !storeId || String(row.id_store) === storeId);
    const historyBySale = new Map(historyRows.map((row) => [String(row.id_sale), Array.isArray(row.histories) ? row.histories : []]));

    const orders: NormalizedOrder[] = sales.map((sale) => {
      const histories = historyBySale.get(String(sale.id_sale)) || [];
      const latest = latestHistory(histories);
      const tableClosed = Number(sale?.table_order?.id_table_order_status) === 1;
      const cancelled = String(sale.canceled || "N").toUpperCase() === "Y";
      const rawStatus = String(latest?.desc_store_sale_status || sale?.partner_sale?.partner_status || (tableClosed ? "Finalizado" : "Em produção"));
      const kind = tableClosed && !cancelled ? "completed" : statusKind(rawStatus, cancelled);
      const finishedAt = ["ready", "completed", "cancelled"].includes(kind) ? (finalTime(histories) || sale.updated_at || null) : null;

      return {
        id: String(sale.id_sale),
        number: displayNumber(sale),
        createdAt: sale.created_at,
        updatedAt: sale.updated_at || sale.created_at,
        kdsEnteredAt: firstProductionTime(histories, sale.created_at),
        kdsFinishedAt: finishedAt,
        status: rawStatus,
        statusKind: kind,
        finishedAt,
        channel: channelName(sale),
        platform: platformName(sale),
        customerName: String(sale?.customer?.name || sale?.desc_sale || "Consumidor não identificado"),
        district: String(sale?.delivery?.district || ""),
        cancelled,
        totalAmount: Number(sale.total_amount || 0),
      };
    });

    const revenue = orders.filter((order) => !order.cancelled).reduce((sum, order) => sum + order.totalAmount, 0);

    return Response.json({
      orders,
      syncedAt,
      source: "saipos",
      storeId: storeId || null,
      summary: {
        orders: orders.filter((order) => !order.cancelled).length,
        revenue,
        cancelled: orders.filter((order) => order.cancelled).length,
      },
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida ao consultar a Saipos.";
    return Response.json({
      error: message,
      orders: [],
      syncedAt,
      source: "saipos",
      stale: true,
    }, { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
