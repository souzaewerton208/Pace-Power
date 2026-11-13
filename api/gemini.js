// Ponte segura para o Gemini: a chave fica guardada na Vercel (variável GEMINI_API_KEY)
// e nunca aparece no código público do GitHub nem nos aparelhos.
module.exports = async (req, res) => {
  const KEY = process.env.GEMINI_API_KEY;

  const q = req.query || {};

  // GET /api/gemini?modelos=1 lista os modelos que esta chave pode usar (só os nomes, nunca a chave)
  if (req.method === "GET" && q.modelos && KEY) {
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

  // Só aceita pedidos vindos do próprio app
  const host = req.headers.host || "";
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin && !origin.includes(host)) return res.status(403).json({ error: "Origem não permitida" });

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  // Modelo pode ser trocado na Vercel pela variável GEMINI_MODEL, sem mexer no código
  // Para testes, ?modelo=<nome> escolhe outro modelo do Gemini e ?semRepetir=1 desliga as novas tentativas
  const pedido = typeof q.modelo === "string" && /^gemini-[\w.-]+$/.test(q.modelo) ? q.modelo : "";
  const MODEL = pedido || process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  // Quando o Google está sobrecarregado (503/500/429) ou a conexão cai, tenta de novo sozinho,
  // com pausas crescentes. Não começa nova tentativa depois de 150 s, para caber no limite da Vercel.
  const PAUSAS = q.semRepetir ? [] : [2000, 5000, 10000];
  const inicio = Date.now();
  let status = 502, text = JSON.stringify({ error: "Falha ao falar com o Gemini" });
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body });
      status = r.status;
      text = await r.text();
      if (![429, 500, 503].includes(status)) break;
    } catch (e) {
      status = 502;
      text = JSON.stringify({ error: "Falha ao falar com o Gemini" });
    }
    if (i >= PAUSAS.length || Date.now() - inicio > 150000) break;
    await new Promise((ok) => setTimeout(ok, PAUSAS[i]));
  }
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(text);
};
