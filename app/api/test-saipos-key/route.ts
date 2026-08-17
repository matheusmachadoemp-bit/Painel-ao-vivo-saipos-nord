const SAIPOS_URL = "https://data.saipos.io/v1/search_sales";

function todaySP() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { key?: string; scheme?: "raw" | "Bearer" };
    const key = body.key?.trim();
    if (!key) {
      return Response.json({ ok: false, error: "Chave não informada." }, { status: 400 });
    }

    const scheme = body.scheme === "Bearer" ? "Bearer" : "raw";
    const authorization = scheme === "Bearer" ? `Bearer ${key}` : key;
    const day = todaySP();
    const url = new URL(SAIPOS_URL);
    url.searchParams.set("p_date_column_filter", "shift_date");
    url.searchParams.set("p_filter_date_start", `${day}T00:00:00`);
    url.searchParams.set("p_filter_date_end", `${day}T23:59:59`);
    url.searchParams.set("p_limit", "1");
    url.searchParams.set("p_offset", "0");

    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
      },
    });

    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch {}

    return Response.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      scheme,
      resultType: Array.isArray(parsed) ? "array" : typeof parsed,
      sample: response.ok ? parsed : undefined,
      error: response.ok ? undefined : parsed,
    }, {
      status: response.ok ? 200 : response.status,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Falha ao testar a chave.",
    }, { status: 500 });
  }
}
