// Ponte com o intervals.icu (que conversa com o Garmin de cada atleta).
// As chaves ficam só na Vercel: INTERVALS_POWER e INTERVALS_PACE, no formato "i123456:CHAVE".
// O app nunca vê as chaves; ele só pede "ler" (treinos feitos e bem-estar) ou "enviar" (treinos planejados).
const { autorizado, origemOk } = require("./_auth");

const VARS = { power: "INTERVALS_POWER", pace: "INTERVALS_PACE" };
function conta(who) {
  const v = String(process.env[VARS[who]] || "").trim();
  const i = v.indexOf(":");
  if (!VARS[who] || i < 1) return null;
  return { id: v.slice(0, i).trim(), key: v.slice(i + 1).trim() };
}
async function api(c, metodo, caminho, corpo) {
  const r = await fetch("https://intervals.icu/api/v1/athlete/" + encodeURIComponent(c.id) + caminho, {
    method: metodo,
    headers: {
      Authorization: "Basic " + Buffer.from("API_KEY:" + c.key).toString("base64"),
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; PacePower/1.0)"
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo)
  });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) {
    const e = new Error((j && (j.error || j.message)) || ("intervals.icu respondeu " + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const n = (x) => (typeof x === "number" && isFinite(x) ? x : null);
// marca dos treinos enviados pelo app, para trocar só eles quando a semana é reenviada
const MARCA = "Pace & Power";

module.exports = async (req, res) => {
  const neg = await autorizado(req);
  if (neg) return res.status(neg.status).json({ error: neg.error });

  // quais atletas já têm a conta do intervals.icu ligada na Vercel
  if (req.method === "GET") return res.json({ power: !!conta("power"), pace: !!conta("pace") });
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });
  if (!origemOk(req)) return res.status(403).json({ error: "Origem não permitida" });

  let b;
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: "Pedido inválido" }); }
  const c = conta(b.who);
  if (!c) return res.status(404).json({ error: "Conta do intervals.icu não ligada para este atleta", code: "sem_conta" });

  try {
    if (b.acao === "ler") {
      if (!DATA.test(b.oldest || "") || !DATA.test(b.newest || "")) return res.status(400).json({ error: "Datas inválidas" });
      const q = `?oldest=${b.oldest}&newest=${b.newest}`;
      const [ats, bem] = await Promise.all([
        api(c, "GET", "/activities" + q).catch((e) => ({ erro: e.message })),
        api(c, "GET", "/wellness" + q).catch((e) => ({ erro: e.message }))
      ]);
      const atividades = Array.isArray(ats) ? ats
        .filter((a) => a && a.type && a.start_date_local)
        .map((a) => ({
          id: String(a.id), data: String(a.start_date_local).slice(0, 10), tipo: a.type, titulo: a.name || "",
          m: n(a.distance), seg: n(a.moving_time) || n(a.elapsed_time), fc: n(a.average_heartrate),
          carga: n(a.icu_training_load)
        })) : [];
      const bemestar = Array.isArray(bem) ? bem.map((w) => ({
        data: String(w.id || "").slice(0, 10), ctl: n(w.ctl), atl: n(w.atl), hrv: n(w.hrv), rhr: n(w.restingHR),
        sono: n(w.sleepSecs), nota: n(w.sleepScore)
      })).filter((w) => DATA.test(w.data)) : [];
      // devolve também quantas vieram vazias (o Garmin pode bloquear o repasse de alguns dados)
      return res.json({
        atividades, bemestar,
        vazias: Array.isArray(ats) ? ats.length - atividades.length : 0,
        avisos: [ats && ats.erro, bem && bem.erro].filter(Boolean)
      });
    }

    if (b.acao === "enviar") {
      const lista = (Array.isArray(b.treinos) ? b.treinos : []).filter((t) => t && DATA.test(t.data || "")).slice(0, 30);
      if (!lista.length) return res.status(400).json({ error: "Nenhum treino para enviar" });
      const datas = lista.map((t) => t.data).sort();
      // tira o que o app já tinha mandado nesses dias (assim reenviar não duplica)
      const ev = await api(c, "GET", `/events?oldest=${datas[0]}&newest=${datas[datas.length - 1]}`);
      const velhos = (Array.isArray(ev) ? ev : [])
        .filter((e) => e && e.category === "WORKOUT" && (String(e.external_id || "").startsWith("pp-") || String(e.description || "").startsWith(MARCA)))
        .map((e) => ({ id: e.id }));
      if (velhos.length) await api(c, "PUT", "/events/bulk-delete", velhos);
      const TIPOS = ["Run", "WeightTraining", "Workout", "Ride", "Swim", "Walk", "Rowing"];
      const eventos = lista.map((t, i) => ({
        category: "WORKOUT",
        start_date_local: t.data + "T00:00:00",
        type: TIPOS.includes(t.tipo) ? t.tipo : "Workout",
        name: String(t.nome || "Treino").slice(0, 120),
        description: (MARCA + "\n\n" + String(t.texto || "")).slice(0, 8000),
        moving_time: Math.max(0, Math.round(+t.min || 0) * 60) || undefined,
        external_id: `pp-${t.data}-${String(t.slot || i).replace(/[^a-z0-9]/gi, "")}`
      }));
      const criados = await api(c, "POST", "/events/bulk?upsert=false&updatePlanApplied=false", eventos);
      return res.json({ enviados: Array.isArray(criados) ? criados.length : eventos.length, trocados: velhos.length });
    }
    return res.status(400).json({ error: "Ação desconhecida" });
  } catch (e) {
    const st = e.status === 401 || e.status === 403 ? 502 : (e.status || 502);
    return res.status(st).json({ error: e.message || "Falha ao falar com o intervals.icu", code: e.status === 401 || e.status === 403 ? "chave" : "" });
  }
};
