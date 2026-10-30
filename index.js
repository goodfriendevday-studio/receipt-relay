// 영수증 중계 서버 (Cloudflare Worker + Durable Object)
// - 휴대폰이 올린 사진을 QR 세션별로 잠깐 보관했다가 PC가 받아 가면 바로 지웁니다.
// - PC가 받지 않아도 첫 업로드 1시간 뒤 세션 전체가 자동 삭제됩니다.
// - 사진 내용은 읽거나 기록하지 않습니다.

const TTL_MS = 60 * 60 * 1000;          // 세션 보관 시간: 1시간
const MAX_BYTES = 1_900_000;            // 사진 한 장 최대 크기 (저장소 한도 2MB)
const MAX_PER_SESSION = 60;             // 세션당 최대 사진 수
const ALLOWED_ORIGINS = [];             // 예: ["https://내아이디.github.io"]  비워 두면 모든 사이트 허용

const SID = /^[A-Za-z0-9_-]{20,64}$/;
const PID = /^[a-f0-9]{16}$/;

function cors(origin) {
  const ok = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-File-Name",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  };
}

export default {
  async fetch(request, env) {
    const c = cors(request.headers.get("Origin") || "");
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...c.headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
    if (!c.ok) return json({ error: "origin_not_allowed" }, 403);

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") return json({ ok: true, service: "receipt-relay" });
    const m = url.pathname.match(/^\/s\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (!m || !SID.test(m[1]) || (m[2] && !PID.test(m[2]))) return json({ error: "not_found" }, 404);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    const inner = new URL("https://room/");
    if (m[2]) inner.searchParams.set("p", m[2]);
    const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
    const res = await stub.fetch(new Request(inner, { method: request.method, headers: request.headers, body }));
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(c.headers)) headers.set(k, v);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  },
};

export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async meta() { return (await this.ctx.storage.get("meta")) || { items: [], taken: [] }; }

  async fetch(request) {
    const st = this.ctx.storage;
    const pid = new URL(request.url).searchParams.get("p");
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

    // 휴대폰 → 사진 올리기
    if (request.method === "POST" && !pid) {
      const type = (request.headers.get("Content-Type") || "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "unsupported_type" }, 415);
      const len = Number(request.headers.get("Content-Length") || 0);
      if (len > MAX_BYTES) return json({ error: "too_large" }, 413);
      const body = await request.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_BYTES) return json({ error: "too_large" }, 413);
      const meta = await this.meta();
      if (meta.items.length + meta.taken.length >= MAX_PER_SESSION) return json({ error: "session_full" }, 429);
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      let name = "receipt.jpg";
      try { name = decodeURIComponent(request.headers.get("X-File-Name") || name).slice(0, 120); } catch {}
      await st.put("img:" + id, body);
      meta.items.push({ id, name, type, size: body.byteLength, t: Date.now() });
      await st.put("meta", meta);
      if ((await st.getAlarm()) == null) await st.setAlarm(Date.now() + TTL_MS);
      return json({ ok: true, id });
    }

    // PC·휴대폰 → 대기 중인 사진 목록 (taken: PC가 이미 받아 간 사진)
    if (request.method === "GET" && !pid) {
      const meta = await this.meta();
      return json({ items: meta.items, taken: meta.taken });
    }

    // PC → 사진 받기 (받는 즉시 서버에서 삭제)
    if (request.method === "GET" && pid) {
      const data = await st.get("img:" + pid);
      if (!data) return json({ error: "gone" }, 404);
      const meta = await this.meta();
      const item = meta.items.find(x => x.id === pid);
      meta.items = meta.items.filter(x => x.id !== pid);
      if (!meta.taken.includes(pid)) meta.taken.push(pid);
      await st.delete("img:" + pid);
      await st.put("meta", meta);
      return new Response(data, { headers: { "Content-Type": (item && item.type) || "image/jpeg" } });
    }

    // PC → 세션 비우기
    if (request.method === "DELETE" && !pid) {
      await st.deleteAll();
      await st.deleteAlarm();
      return json({ ok: true });
    }

    return json({ error: "method_not_allowed" }, 405);
  }

  // 1시간이 지나면 세션 전체 자동 삭제
  async alarm() { await this.ctx.storage.deleteAll(); }
}
