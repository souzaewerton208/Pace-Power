// Lembretes no celular (notificações push), inclusive no iPhone com o app na tela inicial.
// - De manhã (~6h): o treino do dia de cada um e o lembrete da prontidão.
// - À noite (~20h): o que ainda falta registrar no dia (treino feito, dieta).
// A Vercel chama este endereço sozinha nos horários do vercel.json (com o CRON_SECRET).
// Variáveis na Vercel: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET e FIREBASE_SERVICE_ACCOUNT
// (o JSON da conta de serviço do Firebase, para o servidor ler o plano e os registros).
const crypto = require("crypto");
const webpush = require("web-push");
const { autorizado, origemOk } = require("./_auth");

const PROJ = "power-e-pace";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents/artifacts/${PROJ}/public/data`;

// acesso ao Firestore como servidor (conta de serviço), sem bibliotecas extras
let tok = null, tokAte = 0;
async function tokenGoogle() {
  if (tok && Date.now() < tokAte) return tok;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!sa.client_email || !sa.private_key) throw new Error("FIREBASE_SERVICE_ACCOUNT ausente");
  const agora = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b64({ alg: "RS256", typ: "JWT" });
  const p = b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 });
  const s = crypto.createSign("RSA-SHA256").update(h + "." + p).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + h + "." + p + "." + s
  });
  const j = await r.json();
  if (!r.ok) throw new Error("token Google: " + (j.error_description || j.error));
  tok = j.access_token; tokAte = Date.now() + 50 * 60 * 1000;
  return tok;
}
function val(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return +v.integerValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("mapValue" in v) return campos(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  if ("timestampValue" in v) return v.timestampValue;
  return null;
}
const campos = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]));
async function ler(caminho) {
  const r = await fetch(BASE + "/" + caminho, { headers: { Authorization: "Bearer " + (await tokenGoogle()) } });
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Firestore " + r.status);
  return campos(j.fields || {});
}
async function listar(colecao) {
  const r = await fetch(BASE + "/" + colecao + "?pageSize=100", { headers: { Authorization: "Bearer " + (await tokenGoogle()) } });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Firestore " + r.status);
  return (j.documents || []).map((d) => ({ id: d.name.split("/").pop(), ...campos(d.fields || {}) }));
}
async function apagar(caminho) {
  await fetch(BASE + "/" + caminho, { method: "DELETE", headers: { Authorization: "Bearer " + (await tokenGoogle()) } }).catch(() => {});
}

function vapid() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  webpush.setVapidDetails("https://pace-power.vercel.app", pub, priv);
  return pub;
}
async function notificar(item, msg) {
  try {
    await webpush.sendNotification(item.sub, JSON.stringify(msg), { TTL: 6 * 3600, urgency: "normal" });
    return true;
  } catch (e) {
    // aparelho que desinstalou o app ou desligou as notificações: some da lista
    if (e && (e.statusCode === 404 || e.statusCode === 410) && item.id) await apagar("push/" + item.id);
    return false;
  }
}

// ----- conteúdo dos lembretes -----
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // Fortaleza, UTC−3
const diasEntre = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const descanso = (s) => !s || (!(+s.min) && !((s.blocos || []).length)) || /descanso|folga|repouso|\boff\b/i.test((s.titulo || "") + " " + (s.tipo || ""));
function textoNomes(t, cfg) {
  const np = (cfg && cfg.nomes && cfg.nomes.power) || "Ewerton", na = (cfg && cfg.nomes && cfg.nomes.pace) || "Joanna";
  return String(t || "").replace(/\{power\}/g, np).replace(/\{pace\}/g, na);
}
function sessoes(w, dia, i, log) {
  if (w === "power") return { treino: dia.power, corrida: null };
  const o = ((log && log.opt) || {})[i] || "a";
  return { treino: (dia.pace && (dia.pace[o] || dia.pace.a)) || null, corrida: (dia.pace && dia.pace.corrida) || null };
}
function manha(w, dia, i, log, cfg) {
  const { treino, corrida } = sessoes(w, dia, i, log), p = [];
  if (corrida) p.push(`corrida ${textoNomes(corrida.titulo, cfg)}${+corrida.km ? ` (${String(corrida.km).replace(".", ",")} km)` : ""}`);
  if (!descanso(treino)) p.push(`${textoNomes(treino.titulo, cfg)}${+treino.min ? ` (${+treino.min} min)` : ""}`);
  return p.length ? `Hoje: ${p.join(" + ")}. Responda a prontidão antes de treinar.` : "Hoje é dia de descanso. Responda a prontidão e capriche na água.";
}
function noite(w, dia, i, log) {
  const chk = (log && log.chk) || {}, falta = [];
  const { treino, corrida } = sessoes(w, dia, i, log);
  if (corrida && !chk[`${i}:${w}:corrida`]) falta.push("a corrida");
  if (!descanso(treino) && !chk[`${i}:${w}:treino`]) falta.push("o treino");
  const dieta = !((log && log.dietStatus) || {})[`${i}:${w}`];
  if (!falta.length && !dieta) return "";
  const partes = [];
  if (falta.length) partes.push(`marcar ${falta.join(" e ")} como feito${falta.length > 1 ? "s" : ""} (com o esforço)`);
  if (dieta) partes.push("contar como foi a dieta");
  return `Falta ${partes.join(" e ")} de hoje.`;
}

async function rodar(tipo) {
  if (!vapid()) throw new Error("Chaves VAPID ausentes");
  const [plano, cfg, lista] = await Promise.all([ler("plano/v2"), ler("config/v2"), listar("push")]);
  if (!plano || !Array.isArray(plano.dias) || !plano.id) return { enviados: 0, motivo: "sem plano" };
  const i = diasEntre(plano.id, hojeBR());
  if (i < 0 || i >= plano.dias.length) return { enviados: 0, motivo: "hoje fora da semana do plano" };
  const log = await ler("registro/v2-" + plano.id).catch(() => null);
  const dia = plano.dias[i];
  const nome = (w) => w === "power" ? ((cfg && cfg.nomes && cfg.nomes.power) || "Ewerton") : ((cfg && cfg.nomes && cfg.nomes.pace) || "Joanna");
  let enviados = 0;
  for (const item of lista) {
    if (!item || !item.sub || !item.sub.endpoint || item.ativo === false) continue;
    const quem = item.who === "power" || item.who === "pace" ? [item.who] : ["power", "pace"];
    const linhas = quem.map((w) => {
      const t = tipo === "noite" ? noite(w, dia, i, log) : manha(w, dia, i, log, cfg);
      return t && quem.length > 1 ? `${nome(w)}: ${t}` : t;
    }).filter(Boolean);
    if (!linhas.length) continue;
    const ok = await notificar(item, {
      title: tipo === "noite" ? "Registro do dia" : "Treino de hoje",
      body: linhas.join("\n"),
      tag: "pp-" + tipo,
      url: "/"
    });
    if (ok) enviados++;
  }
  return { enviados };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  // chave pública para o app assinar as notificações (não é segredo)
  if (req.method === "GET" && q.chave) return res.json({ chave: process.env.VAPID_PUBLIC_KEY || "" });

  // chamada automática da Vercel nos horários do vercel.json
  if (req.method === "GET" && (q.tipo === "manha" || q.tipo === "noite")) {
    const seg = process.env.CRON_SECRET;
    if (!seg || req.headers.authorization !== "Bearer " + seg) return res.status(401).json({ error: "Não autorizado" });
    try { return res.json(await rodar(q.tipo)); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // teste pedido pelo app: manda uma notificação agora para este aparelho
  if (req.method === "POST") {
    if (!origemOk(req)) return res.status(403).json({ error: "Origem não permitida" });
    const neg = await autorizado(req);
    if (neg) return res.status(neg.status).json({ error: neg.error });
    if (!vapid()) return res.status(503).json({ error: "Chaves dos lembretes não configuradas na Vercel", code: "sem_chave" });
    let b;
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (e) { b = {}; }
    if (!b.sub || !b.sub.endpoint) return res.status(400).json({ error: "Aparelho sem inscrição" });
    const ok = await notificar({ sub: b.sub }, { title: "Pace & Power", body: "Lembretes ligados ✓ Você vai receber o treino do dia de manhã e o que falta registrar à noite.", tag: "pp-teste", url: "/" });
    return ok ? res.json({ ok: true }) : res.status(502).json({ error: "O aparelho não aceitou a notificação" });
  }
  return res.status(405).json({ error: "Método não permitido" });
};
