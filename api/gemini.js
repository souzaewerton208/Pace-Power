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
