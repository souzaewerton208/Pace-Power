// Ponte segura para o Gemini: a chave fica guardada na Vercel (variável GEMINI_API_KEY)
// e nunca aparece no código público do GitHub nem nos aparelhos.
module.exports = async (req, res) => {
  const KEY = process.env.GEMINI_API_KEY;

  // O app pergunta se a IA está disponível
  if (req.method === "GET") return res.json({ ok: !!KEY });
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });
  if (!KEY) return res.status(503).json({ error: "Chave do Gemini não configurada na Vercel" });

  // Só aceita pedidos vindos do próprio app
  const host = req.headers.host || "";
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin && !origin.includes(host)) return res.status(403).json({ error: "Origem não permitida" });

  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body }
    );
    const text = await r.text();
    res.status(r.status).setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "Falha ao falar com o Gemini" });
  }
};
