// Ponte segura para o Gemini: a chave fica guardada na Vercel (variável GEMINI_API_KEY)
// e nunca aparece no código público do GitHub nem nos aparelhos.
const crypto = require("crypto");
const PROJETO = "power-e-pace";

// Confere o comprovante de login do Firebase (ID token) sem bibliotecas extras:
// assinatura RS256 com as chaves públicas do Google, projeto, emissor e validade.
let certs = null, certsAte = 0;
async function chavesGoogle() {
  if (certs && Date.now() < certsAte) return certs;
  const r = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  certs = await r.json();
  const m = (r.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  certsAte = Date.now() + (m ? +m[1] : 3600) * 1000;
  return certs;
}
const b64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function conferirLogin(req) {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const cab = JSON.parse(b64url(h).toString("utf8"));
    const dados = JSON.parse(b64url(p).toString("utf8"));
    if (cab.alg !== "RS256") return null;
    const cert = (await chavesGoogle())[cab.kid];
    if (!cert) return null;
    const ok = crypto.createVerify("RSA-SHA256").update(h + "." + p).verify(cert, b64url(s));
    const agora = Date.now() / 1000;
    if (!ok || dados.aud !== PROJETO || dados.iss !== "https://securetoken.google.com/" + PROJETO || !dados.sub || dados.exp < agora) return null;
    return dados;
  } catch (e) { return null; }
}
// Quem pode usar a IA. Na Vercel, a variável ALLOWED_EMAILS (e-mails separados por vírgula) libera só essas
// contas Google. Sem ela, qualquer pessoa logada no app (inclusive anônima) pode usar, como antes.
async function autorizado(req) {
  const quem = await conferirLogin(req);
  if (!quem) return { status: 401, error: "Entre no app para usar a IA" };
  const lista = String(process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (lista.length && !(quem.email && quem.email_verified && lista.includes(String(quem.email).toLowerCase())))
    return { status: 403, error: "Esta conta não está liberada para usar a IA" };
  return null;
}

module.exports = async (req, res) => {
  const KEY = process.env.GEMINI_API_KEY;

  const q = req.query || {};

  // GET /api/gemini?modelos=1 lista os modelos que esta chave pode usar (só os nomes, nunca a chave)
  if (req.method === "GET" && q.modelos && KEY) {
    const neg = await autorizado(req);
    if (neg) return res.status(neg.status).json({ error: neg.error });
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": KEY } });
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json(j);
      const modelos = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => ({ nome: m.name.replace(/^models\//, ""), titulo: m.displayName, pensa: !!m.thinking }));
      return res.json({ modelos });
    } catch (e) {
      return res.status(502).json({ error: "Falha ao listar modelos" });
    }
  }

  // O app pergunta se a IA está disponível
  if (req.method === "GET") return res.json({ ok: !!KEY });
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });
  if (!KEY) return res.status(503).json({ error: "Chave do Gemini não configurada na Vercel" });

  // Só aceita pedidos vindos do próprio app: o endereço de origem tem que ser exatamente este site.
  // (Antes, um pedido sem origem, como de um script, passava, e "site-falso.com/?<este site>" também.)
  const host = req.headers.host || "";
  let origemHost = "";
  try { origemHost = new URL(req.headers.origin || req.headers.referer || "").host; } catch (e) {}
  if (!host || origemHost !== host) return res.status(403).json({ error: "Origem não permitida" });

  // E só atende quem está logado no app (e, com ALLOWED_EMAILS, só as contas liberadas)
  const negado = await autorizado(req);
  if (negado) return res.status(negado.status).json({ error: negado.error });

  // Monta o pedido aqui em vez de repassar o que chegou: só texto e imagens, resposta em JSON,
  // sem ferramentas extras e com limite de tamanho. Assim ninguém usa a chave para outra coisa.
  let entrada;
  try { entrada = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: "Pedido inválido" }); }
  const partes = (((entrada.contents || [])[0] || {}).parts || [])
    .filter((p) => p && (typeof p.text === "string" || (p.inlineData && typeof p.inlineData.data === "string")))
    .slice(0, 8)
    .map((p) => (typeof p.text === "string"
      ? { text: p.text }
      : { inlineData: { mimeType: String(p.inlineData.mimeType || "image/jpeg"), data: p.inlineData.data } }));
  if (!partes.length) return res.status(400).json({ error: "Pedido vazio" });
  const gcIn = entrada.generationConfig || {};
  const gc = { responseMimeType: "application/json", maxOutputTokens: Math.min(+gcIn.maxOutputTokens || 65536, 65536) };
  const nivel = String((gcIn.thinkingConfig && gcIn.thinkingConfig.thinkingLevel) || "").toUpperCase();
  if (["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(nivel)) gc.thinkingConfig = { thinkingLevel: nivel };
  const body = JSON.stringify({ contents: [{ parts: partes }], generationConfig: gc });

  // Modelo principal e reservas, em ordem. Na Vercel, a variável GEMINI_MODEL pode trocar a lista
  // sem mexer no código (nomes separados por vírgula, ex.: "gemini-3.6-flash,gemini-3.5-flash").
  const MODELOS = (process.env.GEMINI_MODEL || "gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite")
    .split(",").map((s) => s.trim()).filter(Boolean);

  // Se um modelo estiver sobrecarregado (500/503), sem cota (429) ou a conexão cair, passa na hora
  // para o próximo da lista. Depois da lista toda, dá mais uma volta após 5 s.
  // Não começa nova tentativa depois de 150 s, para caber no limite da Vercel.
  const RETENTAR = [429, 500, 502, 503, 504];
  const inicio = Date.now();
  let status = 502, text = JSON.stringify({ error: "Falha ao falar com o Gemini" });
  fora: for (let volta = 0; volta < 2; volta++) {
    if (volta > 0) await new Promise((ok) => setTimeout(ok, 5000));
    for (const modelo of MODELOS) {
      if (Date.now() - inicio > 150000) break fora;
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body }
        );
        status = r.status;
        text = await r.text();
        if (!RETENTAR.includes(status)) break fora;
      } catch (e) {
        status = 502;
        text = JSON.stringify({ error: "Falha ao falar com o Gemini" });
      }
    }
  }
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(text);
};
