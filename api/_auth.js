// Conferências comuns às pontes do servidor (o "_" no nome faz a Vercel não publicar este arquivo como endereço).
const crypto = require("crypto");
const PROJETO = "power-e-pace";

// Confere o comprovante de login do Firebase (ID token): assinatura RS256 com as chaves públicas do Google,
// projeto, emissor e validade.
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
// Só contas Google liberadas em ALLOWED_EMAILS (variável da Vercel, e-mails separados por vírgula).
async function autorizado(req) {
  const quem = await conferirLogin(req);
  if (!quem) return { status: 401, error: "Entre no app com a conta Google" };
  const lista = String(process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (lista.length && !(quem.email && quem.email_verified && lista.includes(String(quem.email).toLowerCase())))
    return { status: 403, error: "Esta conta não está liberada" };
  return null;
}
// Pedido vindo do próprio app (mesmo endereço de origem)
function origemOk(req) {
  const host = req.headers.host || "";
  let origemHost = "";
  try { origemHost = new URL(req.headers.origin || req.headers.referer || "").host; } catch (e) {}
  return !!host && origemHost === host;
}
module.exports = { autorizado, origemOk };
