// 마켓맵 시세 중계(Cloudflare Worker).
// GET /kr?codes=005930,000660,...  →  {"at": "...", "d": {"005930": [현재가, 등락률%], ...}}
// 네이버 실시간 시세는 브라우저(GitHub Pages)에서 바로 부르면 막혀서 여기서 받아 넘긴다.
// 같은 종목 묶음은 5초 동안 캐시해서 네이버로 가는 요청 수를 일정하게 유지한다.

const ALLOWED = ["https://dongdongadrie.github.io", "http://127.0.0.1:8765"];
const CACHE_SEC = 5;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Methods": "GET",
    "Vary": "Origin",
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (origin && !ALLOWED.includes(origin)) return new Response("forbidden", { status: 403 });
    if (url.pathname !== "/kr") return new Response("not found", { status: 404, headers: cors(origin) });

    const codes = (url.searchParams.get("codes") || "").split(",").filter(c => /^[0-9A-Z]{6}$/.test(c)).slice(0, 400);
    if (!codes.length) return new Response("codes required", { status: 400, headers: cors(origin) });

    // 캐시 키는 종목 목록 기준(Origin 과 무관)
    const cacheKey = new Request("https://cache.local/kr/" + codes.join(","));
    const cache = caches.default;
    let hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      Object.entries(cors(origin)).forEach(([k, v]) => r.headers.set(k, v));
      return r;
    }

    const out = {};
    // 한 번에 너무 길면 두 번에 나눠 부른다
    for (let i = 0; i < codes.length; i += 200) {
      const q = codes.slice(i, i + 200).join(",");
      const res = await fetch("https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:" + q, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com/" },
      });
      if (!res.ok) return new Response("upstream " + res.status, { status: 502, headers: cors(origin) });
      const j = await res.json();
      for (const a of j.result?.areas || []) {
        for (const x of a.datas || []) {
          // rf: 1 상한, 2 상승, 3 보합, 4 하한, 5 하락. cr 은 부호 없이 올 때가 있어 rf 로 맞춘다
          let cr = Number(x.cr);
          if ((x.rf === "4" || x.rf === "5") && cr > 0) cr = -cr;
          out[x.cd] = [x.nv, cr];
        }
      }
    }
    const body = JSON.stringify({ at: new Date().toISOString(), d: out });
    const resp = new Response(body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_SEC}` },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    const r = new Response(body, resp);
    Object.entries(cors(origin)).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  },
};
