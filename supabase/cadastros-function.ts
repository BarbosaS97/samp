// Edge Function "cadastros-function" - única porta de acesso aos dados do SAMP.
//  - login (matrícula autorizada)          -> devolve token de sessão
//  - ler   (token OU senha de cadastro)    -> leituras das tabelas, só depois de validar o acesso
//  - demais ações (escrita / usuários)     -> exigem SENHA_CADASTRO
// Secret necessário: SENHA_CADASTRO (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const MAX_CORPO = 40 * 1024 * 1024;   // recusa pedidos gigantes (a maior importação, 50 mil processos, fica bem abaixo disso)
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

function igual(a: string, b: string) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}

const CAMPOS = ["recebidos", "calculados", "acervo", "tempo"];
const TABELAS = ["processos", "configuracoes", "config_periodos", "dados_processos", "processos_fotos", "processos_fotos_assuntos", "producao_resumo", "producao_calendario", "producao_apelidos"];
const SESSAO_MS = 8 * 60 * 60 * 1000; // 8 horas
const nums = (v: unknown, n: number) =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && isFinite(x));
const normMatricula = (m: unknown) => String(m ?? "").replace(/\s+/g, "").toUpperCase();
const matriculaValida = (m: string) => /^[A-Z0-9._-]{3,30}$/.test(m);

/* ---------- token de sessão assinado (HMAC) ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function chave() {
  const base = await crypto.subtle.digest("SHA-256", enc.encode("samp-token:" + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")));
  return crypto.subtle.importKey("raw", base, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function criarToken(dados: { m: string; n: string }) {
  const agora = Date.now();
  const corpo = b64u(enc.encode(JSON.stringify({ ...dados, iat: agora, exp: agora + SESSAO_MS })));
  const sig = b64u(await crypto.subtle.sign("HMAC", await chave(), enc.encode(corpo)));
  return { token: `${corpo}.${sig}`, exp: agora + SESSAO_MS };
}
async function lerToken(token: unknown): Promise<{ m: string; n: string; iat: number } | null> {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [corpo, sig] = token.split(".");
  if (!corpo || !sig) return null;
  const esperado = b64u(await crypto.subtle.sign("HMAC", await chave(), enc.encode(corpo)));
  if (!igual(sig, esperado)) return null;
  try {
    const d = JSON.parse(dec.decode(deb64u(corpo)));
    return d.exp > Date.now() ? { m: d.m, n: d.n, iat: Number(d.iat) || 0 } : null;
  } catch { return null; }
}

// sessão válida = token assinado + matrícula ainda ativa + senha não redefinida depois do login
async function sessaoAtiva(db: any, token: unknown) {
  const s = await lerToken(token);
  if (!s) return null;
  const { data: u } = await db.from("usuarios").select("ativo, senha_definida_em").eq("matricula", s.m).maybeSingle();
  if (!u?.ativo || !u.senha_definida_em || !s.iat || Date.parse(u.senha_definida_em) > s.iat) return null;
  return s;
}

/* ---------- limite de tentativas (persistente e atômico; ver sql/14_seguranca.sql) ---------- */
const ipDe = (req: Request) =>
  (req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "desconhecido").slice(0, 60);
async function segundosBloqueado(db: any, chave: string): Promise<number> {
  try {
    const { data } = await db.from("seguranca_tentativas").select("bloqueado_ate").eq("chave", chave).maybeSingle();
    const resta = data?.bloqueado_ate ? Date.parse(data.bloqueado_ate) - Date.now() : 0;
    return resta > 0 ? Math.ceil(resta / 1000) : 0;
  } catch { return 0; }   // se o controle estiver indisponível, não derruba o login
}
async function registrarFalha(db: any, chave: string, max: number, janelaS: number, bloqueioS: number) {
  try {
    const { error } = await db.rpc("registrar_falha", { p_chave: chave, p_max: max, p_janela_s: janelaS, p_bloqueio_s: bloqueioS });
    if (error) console.error("registrar_falha:", error.message);   // normalmente: o SQL 14 ainda não foi executado
  } catch (e) { console.error("registrar_falha:", (e as Error)?.message); }
}
const limparFalhas = async (db: any, chave: string) => { try { await db.from("seguranca_tentativas").delete().eq("chave", chave); } catch { /* sem efeito */ } };
const tentarDepois = (s: number) => json({ error: `Muitas tentativas. Tente novamente em ${Math.max(1, Math.ceil(s / 60))} minuto(s).`, retry_after: s }, 429);
// limites: por matrícula 5 falhas / 15 min -> bloqueio de 15 min; por endereço 30 falhas / 15 min -> 15 min; senha de cadastro 8 falhas / 15 min -> 30 min
const falhaMatricula = (db: any, m: string) => registrarFalha(db, "m:" + m, 5, 900, 900);
const falhaIp = (db: any, ip: string) => registrarFalha(db, "ip:" + ip, 30, 900, 900);
const falhaAdmin = (db: any, ip: string) => registrarFalha(db, "adm:" + ip, 8, 900, 1800);

/* ---------- senha (PBKDF2-SHA256 com sal individual) ---------- */
const ITER_SENHA = 100000;
const senhaValida = (s: unknown): s is string => typeof s === "string" && s.length >= 8 && s.length <= 100;
async function derivar(senha: string, sal: Uint8Array, iter: number) {
  const k = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  return b64u(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iter }, k, 256));
}
async function hashSenha(senha: string) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER_SENHA}$${b64u(sal)}$${await derivar(senha, sal, ITER_SENHA)}`;
}
async function conferirSenha(senha: string, guardado: string) {
  const [alg, iter, sal, h] = guardado.split("$");
  if (alg !== "pbkdf2" || !iter || !sal || !h) return false;
  return igual(await derivar(senha, deb64u(sal), Number(iter)), h);
}

/* ---------- leitura controlada ---------- */
async function ler(db: any, q: any, admin: boolean) {
  const tabela = q.table;
  if (!(TABELAS.includes(tabela) || (admin && tabela === "usuarios"))) return json({ error: "Tabela não permitida" }, 400);
  let cols = typeof q.select === "string" && /^[a-zA-Z_*, ]+$/.test(q.select) ? q.select : "*";
  if (tabela === "usuarios") cols = "matricula, nome, ativo, criado_em, ultimo_acesso";   // nunca devolve o hash da senha
  let qb = db.from(tabela).select(cols, q.count ? { count: "exact", head: !!q.head } : undefined);
  for (const [k, v] of Object.entries(q.eq ?? {})) {
    if (!/^[a-zA-Z_]+$/.test(k) || !["string", "number", "boolean"].includes(typeof v)) return json({ error: "Filtro inválido" }, 400);
    qb = qb.eq(k, v);
  }
  if (q.order) {
    if (!/^[a-zA-Z_]+$/.test(q.order.col ?? "")) return json({ error: "Ordenação inválida" }, 400);
    qb = qb.order(q.order.col, { ascending: q.order.asc !== false });
  }
  if (Array.isArray(q.range)) {
    const [a, z] = q.range.map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(z) || a < 0 || z < a || z - a > 999) return json({ error: "Faixa inválida" }, 400);
    qb = qb.range(a, z);
  }
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return json({ error: "Limite inválido" }, 400);
    qb = qb.limit(n);
  }
  if (q.single) qb = qb.single();
  const { data, count, error } = await qb;
  if (error) { console.error("ler:", error.message); return json({ error: admin ? error.message : "Não foi possível consultar os dados." }, 500); }
  return json({ data, count });
}

/* ---------- unificação das varas pela numeração ----------
   1 a 22 = Varas Comuns; 23 a 27 = Juizados Especiais (JEF).
   Adjuntos têm o tipo invertido: adjunto de vara comum é JEF; adjunto de vara JEF é Cível.
   UNIFICAR_ADJUNTOS = true  -> o adjunto soma na mesma vara (mesmo nome); o detalhe fica em "adjunto"/"vara_tipo".
   UNIFICAR_ADJUNTOS = false -> o adjunto aparece como linha separada: "11ª Vara - Brasília (Adjunto JEF)". */
const UNIFICAR_ADJUNTOS = true;
const ULTIMA_VARA_COMUM = 22;
const ULTIMA_VARA = 27;
const CIDADE = "Brasília";

type InfoVara = { nome: string; num: number | null; tipo: "comum" | "jef" | null; adjunto: boolean; aviso?: string };
const semAcento = (x: string) => String(x ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function normalizarVara(original: unknown): InfoVara {
  const bruto = String(original ?? "").trim();
  const t = semAcento(bruto);
  const m = t.match(/(?<!\d)(\d{1,2})(?!\d)/);   // primeiro número de 1 ou 2 dígitos ("05ª", "23ª"...)
  const n = m ? parseInt(m[1], 10) : 0;
  if (!m || n < 1 || n > ULTIMA_VARA) {
    return { nome: bruto || "Não informada", num: null, tipo: null, adjunto: false, aviso: "Número da vara (1 a 27) não reconhecido; mantido como veio" };
  }
  const varaJef = n > ULTIMA_VARA_COMUM;
  const adjunto = /\badj/.test(t);
  const textoJef = /\bjef\b|juizado/.test(t);
  const tipo: "comum" | "jef" = adjunto ? (varaJef ? "comum" : "jef") : (varaJef ? "jef" : "comum");
  const base = varaJef ? `${n}ª Vara JEF - ${CIDADE}` : `${n}ª Vara - ${CIDADE}`;
  const nome = adjunto && !UNIFICAR_ADJUNTOS ? `${base} (Adjunto ${tipo === "jef" ? "JEF" : "Cível"})` : base;
  let aviso: string | undefined;
  if (!adjunto && textoJef && !varaJef) aviso = `O texto cita JEF, mas a vara ${n} é comum`;
  else if (adjunto && varaJef && /^\s*jef\s*adj/.test(t)) aviso = `Adjunto da vara ${n} (JEF) aparece como "JEF Adj"; o esperado é Cível`;
  else if (adjunto && !varaJef && /^\s*civel\s*adj/.test(t)) aviso = `Adjunto da vara ${n} (comum) aparece como "Cível Adj"; o esperado é JEF`;
  return { nome, num: n, tipo, adjunto, aviso };
}

/* ---------- unificação de assuntos ----------
   Camadas, da mais segura para a menos segura:
   1) regras confirmadas pelo usuário (tabela assuntos_equivalencias);
   2) nomes iguais exceto por maiúsculas, acentos, pontuação e espaços são unidos automaticamente (fica o mais frequente);
   3) nomes PARECIDOS (palavra diferente, como "Lei" x "LL") só viram SUGESTÃO para o usuário confirmar.
   Nunca se sugere unir nomes cujos NÚMEROS são diferentes (ex.: "Índice de 13,23%" x "Índice de 3,17%"). */
const chaveAssunto = (t: unknown) => semAcento(String(t ?? "")).replace(/[^a-z0-9]+/g, " ").trim();

function montarPrevia(cont: Map<string, number>, eq: Map<string, string>) {
  const mapa = mapearAssuntos(cont, eq);
  const finais = new Map<string, number>();
  const automaticos: { de: string; para: string; motivo: string; qtd: number }[] = [];
  for (const [texto, qtd] of cont) {
    const m = mapa.get(texto)!;
    finais.set(m.final, (finais.get(m.final) ?? 0) + qtd);
    if (m.motivo) automaticos.push({ de: texto, para: m.final, motivo: m.motivo, qtd });
  }
  automaticos.sort((x, y) => y.qtd - x.qtd);
  return { ok: true, total_textos: cont.size, total_finais: finais.size, automaticos, grupos: sugerirGrupos(finais) };
}

async function carregarEquivalencias(db: any): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const { data } = await db.from("assuntos_equivalencias").select("chave,canonico");
  for (const r of data ?? []) m.set(r.chave, r.canonico);
  return m;
}

type MapaAssunto = { final: string; motivo: "regra" | "igual" | null };
function mapearAssuntos(contagens: Map<string, number>, eq: Map<string, string>): Map<string, MapaAssunto> {
  const porChave = new Map<string, { texto: string; qtd: number }[]>();
  for (const [texto, qtd] of contagens) {
    const k = chaveAssunto(texto);
    if (!porChave.has(k)) porChave.set(k, []);
    porChave.get(k)!.push({ texto, qtd });
  }
  const resolver = (k: string): string | undefined => {   // segue a regra até o nome final (no máximo 5 saltos)
    let atual = eq.get(k);
    for (let i = 0; atual && i < 5; i++) {
      const prox = eq.get(chaveAssunto(atual));
      if (!prox || prox === atual) break;
      atual = prox;
    }
    return atual;
  };
  const resultado = new Map<string, MapaAssunto>();
  for (const [k, lista] of porChave) {
    lista.sort((a, b) => (b.qtd - a.qtd) || a.texto.localeCompare(b.texto, "pt-BR"));
    const regra = resolver(k);
    for (const v of lista) {
      if (regra) resultado.set(v.texto, { final: regra, motivo: v.texto === regra ? null : "regra" });
      else resultado.set(v.texto, { final: lista[0].texto, motivo: v.texto === lista[0].texto ? null : "igual" });
    }
  }
  return resultado;
}

function distancia(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// sugere grupos de nomes parecidos (já com as regras aplicadas); só compara nomes com os MESMOS números
function sugerirGrupos(finais: Map<string, number>) {
  const itens = [...finais.entries()].map(([texto, qtd]) => {
    const toks = chaveAssunto(texto).split(" ").filter(Boolean);
    return { texto, qtd, num: toks.filter((x) => /^\d+$/.test(x)).join(" "), txt: toks.filter((x) => !/^\d+$/.test(x)).join(" ") };
  });
  const porNum = new Map<string, typeof itens>();
  for (const it of itens) { if (!porNum.has(it.num)) porNum.set(it.num, []); porNum.get(it.num)!.push(it); }

  const pai = new Map<string, string>();
  const raiz = (x: string): string => { let r = x; while (pai.get(r) !== r) r = pai.get(r)!; return r; };
  const pares: { a: string; sim: number }[] = [];   // pares parecidos (para informar a similaridade do grupo)
  for (const [num, lista] of porNum) {
    for (const it of lista) pai.set(it.texto, it.texto);
    const limiar = num ? 0.82 : 0.85;          // sem números no nome, exige-se um pouco mais de semelhança
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
      const a = lista[i], b = lista[j];
      const tam = Math.max(a.txt.length, b.txt.length);
      if (!tam || Math.abs(a.txt.length - b.txt.length) / tam > 0.3) continue;
      const sim = 1 - distancia(a.txt, b.txt) / tam;
      if (sim >= limiar) {
        const ra = raiz(a.texto), rb = raiz(b.texto);
        if (ra !== rb) pai.set(ra, rb);
        pares.push({ a: a.texto, sim });
      }
    }
  }
  const grupos = new Map<string, { texto: string; qtd: number }[]>();
  for (const it of itens) {
    const r = raiz(it.texto);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r)!.push({ texto: it.texto, qtd: it.qtd });
  }
  return [...grupos.entries()].filter(([, v]) => v.length > 1).map(([r, v]) => {
    v.sort((a, b) => b.qtd - a.qtd);
    const sims = pares.filter((p) => raiz(p.a) === r).map((p) => p.sim);
    return { similaridade: Math.round(Math.max(0, ...sims) * 100) / 100, variantes: v, sugerido: v[0].texto, total: v.reduce((acc, x) => acc + x.qtd, 0) };
  }).sort((x, y) => y.total - x.total).slice(0, 80);
}

/* ---------- fotos da importação (histórico real de acervo, entradas e saídas por assunto) ---------- */
function faixaIdade(d: number): "f0_30" | "f31_60" | "f61_90" | "f91_120" | "f121_180" | "f181_365" | "f366_mais" {
  return d <= 30 ? "f0_30" : d <= 60 ? "f31_60" : d <= 90 ? "f61_90" : d <= 120 ? "f91_120" : d <= 180 ? "f121_180" : d <= 365 ? "f181_365" : "f366_mais";
}

async function lerBaseAtual(db: any): Promise<Map<string, string>> {
  const m = new Map<string, string>();   // número do processo -> assunto
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("processos").select("numero_processo,assunto_principal").order("id").range(off, off + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (r.numero_processo) m.set(r.numero_processo, r.assunto_principal ?? "");
    if (!data || data.length < 1000) break;
  }
  return m;
}

async function gravarFoto(db: any, ts: string, novos: any[], antigos: Map<string, string>) {
  const temAnterior = antigos.size > 0;
  type Ag = { assunto: string; qtd: number; entradas: number; saidas: number; soma_dias: number; [k: string]: number | string };
  const por = new Map<string, Ag>();
  const pega = (assunto: string): Ag => {
    let a = por.get(assunto);
    if (!a) { a = { assunto, qtd: 0, entradas: 0, saidas: 0, soma_dias: 0, f0_30: 0, f31_60: 0, f61_90: 0, f91_120: 0, f121_180: 0, f181_365: 0, f366_mais: 0 }; por.set(assunto, a); }
    return a;
  };
  const numerosNovos = new Set<string>();
  for (const p of novos) {
    const a = pega(p.assunto_principal ?? "");
    a.qtd++; a.soma_dias += Number(p.dias_chegada) || 0;
    (a as any)[faixaIdade(Number(p.dias_chegada) || 0)]++;
    numerosNovos.add(p.numero_processo);
    if (temAnterior && !antigos.has(p.numero_processo)) a.entradas++;
  }
  if (temAnterior) for (const [num, assunto] of antigos) if (!numerosNovos.has(num)) pega(assunto).saidas++;

  let ent = 0, sai = 0;
  for (const a of por.values()) { ent += a.entradas; sai += a.saidas; }
  const { data: foto, error } = await db.from("processos_fotos").insert({ data_foto: ts, total: novos.length, entradas: temAnterior ? ent : null, saidas: temAnterior ? sai : null }).select("id").single();
  if (error) throw new Error(error.message);
  const linhas = [...por.values()].map((a) => ({ ...a, foto_id: foto.id, entradas: temAnterior ? a.entradas : null, saidas: temAnterior ? a.saidas : null }));
  for (let i = 0; i < linhas.length; i += 500) {
    const { error: e2 } = await db.from("processos_fotos_assuntos").insert(linhas.slice(i, i + 500));
    if (e2) { await db.from("processos_fotos").delete().eq("id", foto.id); throw new Error(e2.message); }
  }
  return { entradas: temAnterior ? ent : null, saidas: temAnterior ? sai : null };
}

/* ---------- Produção Individual: agrupamento de assuntos e resumo por pessoa ----------
   O objeto de cada processo vem digitado à mão nas planilhas (centenas de grafias). As regras abaixo
   (aplicadas ao texto sem acento, em maiúsculas e sem pontuação; a primeira que casar vale) levam tudo para um
   assunto agrupado. O texto original continua guardado; para mudar uma regra, edite a lista e use
   "Recalcular" em Cadastros (não precisa importar as planilhas de novo). */
const GRUPOS_REGRAS: [string, string][] = [
  ["Imposto de renda", "^(IR|IRFP|IRPF|RRA)( |$)|IMPO?RTO DE RENDA"],
  ["PSS (contribuição previdenciária)", "(^| )(PSS|CPSS)( |$)|CONT ACIMA DO TETO"],
  ["28,86%", "28 86|(^| )2886"],
  ["13,23%", "13 23|(^| )0 1323|(^| )1323"],
  ["3,17%", "(^| )3 17( |$)|0 0317|(^| )0317"],
  ["11,98%", "11 98|(^| )0 1198"],
  ["Fundef / FPM", "FUNDEF|(^| )FPM( |$)|FUNDO DE PARTICIPACAO"],
  ["ECEE", "(^| )ECEE"],
  ["Honorários", "HONORARIO"],
  ["FGTS", "FGTS"],
  ["Diferenças salariais", "^DIF(ERENCA|S)?( |$)|^DIFERENCA"],
  ["Previdenciário", "PREVIDENC|^INSS|^JEF INSS|^PREVI( |$)|BENEFICIO|AUXILIO (INCAPACIDADE|DOENCA|ACIDENTE|RECLUSAO)|APOSENTADORIA|^BPC|^PENSAO( POR MORTE)?$|SALARIO MATERNIDADE|VIDA TODA|CNIS|(^| )TETO|^LOAS"],
  ["Precatório / RPV", "PRECATORIO|^RPV|PRINCIPAL JUROS"],
  ["Horas extras", "HORAS? EXTRAS?|^H E$"],
  ["SUS", "(^| )SUS( |$)|TUNEP"],
  ["Gratificações e adicionais", "GRATIFICA|^GD[A-Z]+|^GIFA|^GOE|^GAT( |$)|ABONO|ADICIONAL|PERICULOSIDADE|INSALUBRIDADE|^VPE|^PAE"],
  ["Servidores (carreira)", "PROG FUNCIONAL|PROGRESSAO|ENQUADRAMENTO|QUINTOS|LICENCA PREMIO|FERIAS|REINTEGRACAO|ANISTIA|RESIDENCIA MEDICA|PROMOCAO|AUXILIO (MORADIA|CRECHE)|PRE ESCOLAR|DIARIAS|PENSAO MILITAR|^REFORMA|INCORPORACAO|^RAV|^IVC|SALARIO EDUCACAO|REAJUSTE|PERICIA|^ABATE"],
  ["Tributário e execução fiscal", "TRIBUT|ICMS|(^| )PIS( |$)|COFINS|^IPI|SISCOMEX|^TAXAS?( |$)|EXECUCAO FISCAL|EXEC FISCAL|^EF( |$)|ROYALTIES|^IRPJ|CONT SOCIAL|CONTRIBUICOES SOCIAIS|CREDITO IPI"],
  ["Contratos, monitória e financeiro", "CONTRATO|^SFH|SIST REMUNERATORIO|^FIES|^TDA|MONITORIA|^IPC|COR MON|CORRECAO MONETARIA|JUROS PROGRESSIVOS"],
  ["Dano moral e indenizações", "DANO|INDENIZ"],
  ["Criminal, multas e custas", "CRIMINAL|PENAL|MULTA|CUSTAS"],
  ["Atualização e adequação", "ATUALIZA|ADEQUACAO|RATEIO|DEVOLUCAO|VALOR INCONTROVERSO|RESOLUCAO"],
  ["PRF e DNIT", "^(PRF|DNIT)( |$)"],
  ["Pedido da vara", "PEDIDO DA VARA"],
  ["Recesso", "RECESSO"]
];
const GRUPOS_RX: [string, RegExp][] = GRUPOS_REGRAS.map(([n, r]): [string, RegExp] => [n, new RegExp(r)]);
const chaveObjeto = (x: unknown) =>
  String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
function grupoDoObjeto(x: unknown): string {
  const k = chaveObjeto(x);
  if (!k) return "Sem objeto";
  for (const [nome, rx] of GRUPOS_RX) if (rx.test(k)) return nome;
  return "Outros";
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function primeiroDiaMesAtual(): string {   // meses em andamento não entram (a planilha é enviada após a virada do mês)
  const sp = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  return sp.slice(0, 8) + "01";
}
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
function prioridadeCodigo(x: unknown): number {   // 0 sem prioridade, 1 sim, 2 acima de 60 dias, 3 prioridade legal
  const k = chaveObjeto(x);
  if (!k) return 0;
  if (/60/.test(k)) return 2;
  if (/LEGAL/.test(k)) return 3;
  if (/^SIM/.test(k)) return 1;
  return 0;
}
const horaExtra = (x: unknown) => (/HORAS? EXTRAS?/.test(chaveObjeto(x)) ? 1 : 0);

function montarResumo(itens: any[]) {
  const nomes: string[] = [];
  const idx = new Map<string, number>();
  const m = new Map<string, number[]>();
  const g = new Map<string, number[]>();
  const d = new Map<string, number>();
  const procs = new Map<string, number>();
  let primeira = "", ultima = "";
  for (const it of itens) {
    const data = String(it.data);
    const ano = +data.slice(0, 4), mes = +data.slice(5, 7);
    const tipo = it.tipo === "META" ? 0 : it.tipo === "ACERVO" ? 1 : 2;
    const prio = prioridadeCodigo(it.prioridade), he = horaExtra(it.observacao);
    let dias = -1;
    if (it.recebido_em && ISO.test(String(it.recebido_em))) { const x = diasEntre(String(it.recebido_em), data); if (x >= 0 && x <= 1500) dias = x; }
    const k = `${ano}|${mes}|${tipo}|${prio}|${he}`;
    const a = m.get(k) ?? [ano, mes, tipo, prio, he, 0, 0, 0];
    a[5]++; if (dias >= 0) { a[6] += dias; a[7]++; }
    m.set(k, a);
    const gn = grupoDoObjeto(it.objeto);
    let gi = idx.get(gn);
    if (gi === undefined) { gi = nomes.length; nomes.push(gn); idx.set(gn, gi); }
    const kg = `${ano}|${gi}`;
    const b = g.get(kg) ?? [ano, gi, 0];
    b[2]++; g.set(kg, b);
    d.set(data, (d.get(data) ?? 0) + 1);
    const pk = String(it.processo).trim();
    procs.set(pk, (procs.get(pk) ?? 0) + 1);
    if (!primeira || data < primeira) primeira = data;
    if (!ultima || data > ultima) ultima = data;
  }
  let refeitos = 0, repetidos = 0;
  for (const v of procs.values()) if (v > 1) { repetidos++; refeitos += v - 1; }
  return {
    primeira, ultima, total: itens.length,
    dados: {
      m: [...m.values()], gn: nomes, g: [...g.values()], d: [...d].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      r: { distintos: procs.size, repetidos, refeitos },
    },
  };
}

async function recalcularPessoa(db: any, pessoa: string, arquivo?: string | null, ts?: string) {
  // sempre usa só a importação mais recente da pessoa (sobras de importações antigas nunca entram na conta)
  let alvo = ts;
  if (!alvo) {
    const { data: u, error: eU } = await db.from("producao_itens").select("importado_em").eq("pessoa", pessoa).order("importado_em", { ascending: false }).limit(1);
    if (eU) throw new Error(eU.message);
    alvo = u?.[0]?.importado_em;
  }
  const itens: any[] = [];
  if (alvo) for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("producao_itens").select("data,processo,objeto,prioridade,observacao,recebido_em,tipo")
      .eq("pessoa", pessoa).eq("importado_em", alvo).order("id").range(off, off + 999);
    if (error) throw new Error(error.message);
    itens.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  if (!itens.length) { await db.from("producao_resumo").delete().eq("pessoa", pessoa); return 0; }
  const r = montarResumo(itens);
  const linha: any = { pessoa, dados: r.dados, total: r.total, primeira_data: r.primeira, ultima_data: r.ultima, atualizado_em: new Date().toISOString() };
  if (arquivo !== undefined) linha.arquivo = arquivo;
  const { error } = await db.from("producao_resumo").upsert(linha, { onConflict: "pessoa" });
  if (error) throw new Error(error.message);
  return r.total;
}

/* ---------- calendário de ausências (planilha CALENDÁRIO SECAJ) ---------- */
// categorias: f férias, l licença (inclui licença saúde, sempre mostrada de forma genérica), t treinamento/licença capacitação,
// x falta, r recesso/eleitoral. Textos de observação que revelem motivo de saúde ou questões disciplinares viram só "Ausência".
const CAT_CAL = ["f", "l", "t", "x", "r"];
const NOTA_SENSIVEL = /atestado|sa[uú]de|m[eé]dic|doen[cç]a|cirurg|exame|\bcid\b|falta injustificada|d[eé]bito|advert|disciplin|puni[cç]/i;
function limparCalendario(d: any) {
  const out: Record<string, any> = {};
  const m = d?.m && typeof d.m === "object" ? d.m : {};
  const n = (x: unknown) => { const t = Math.round(Number(x)); return Number.isFinite(t) && t >= 0 && t <= 31 ? t : 0; };
  for (const [k, v] of Object.entries<any>(m)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(k) || !v || typeof v !== "object") continue;
    const item: any = { u: n(v.u), f: n(v.f), l: n(v.l), t: n(v.t), x: n(v.x), r: n(v.r), p: [], n: [] };
    for (const p of Array.isArray(v.p) ? v.p.slice(0, 20) : []) {
      if (Array.isArray(p) && CAT_CAL.includes(p[0]) && ISO.test(String(p[1])) && ISO.test(String(p[2]))) item.p.push([p[0], p[1], p[2], n(p[3])]);
    }
    for (const x of Array.isArray(v.n) ? v.n.slice(0, 10) : []) {
      if (!Array.isArray(x)) continue;
      const dia = n(x[0]);
      let t = String(x[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (NOTA_SENSIVEL.test(t)) t = "Ausência";
      if (dia >= 1 && t) item.n.push([dia, t]);
    }
    if (item.u || item.f || item.l || item.t || item.x || item.r || item.p.length || item.n.length) out[k] = item;
  }
  return out;
}
const chaveNomeCal = (x: unknown) =>
  String(x ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
const nomePessoa = (x: unknown) => String(x ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  if (Number(req.headers.get("content-length") ?? 0) > MAX_CORPO) return json({ error: "Pedido grande demais" }, 413);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Requisição inválida" }, 400); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Requisição inválida" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const falha = (e: any) => { console.error("erro:", e?.message ?? e); return json({ error: e?.message ?? String(e) }, 500); };
  const ip = ipDe(req);

  try {
    /* ===== 1) Login: matrícula autorizada + senha ===== */
    if (b.action === "login_matricula" || b.action === "login" || b.action === "definir_senha") {
      const m = normMatricula(b.matricula);
      // bloqueio por excesso de tentativas (checado ANTES de qualquer cálculo de hash, para não gastar CPU com quem ataca)
      const esperaIp = await segundosBloqueado(db, "ip:" + ip);
      if (esperaIp) return tentarDepois(esperaIp);
      if (matriculaValida(m)) { const esperaM = await segundosBloqueado(db, "m:" + m); if (esperaM) return tentarDepois(esperaM); }

      const { data: u } = matriculaValida(m)
        ? await db.from("usuarios").select("matricula, nome, ativo, senha_hash").eq("matricula", m).maybeSingle()
        : { data: null };
      if (!u || !u.ativo) { await falhaIp(db, ip); await espera(900); return json({ error: "Matrícula não autorizada" }, 401); }

      // etapa 1: matrícula autorizada -> informa se já existe senha
      if (b.action === "login_matricula") return json({ ok: true, nome: u.nome, tem_senha: !!u.senha_hash });

      // etapa 2: senha (existente ou, no primeiro acesso, a nova senha escolhida)
      const atualizar: Record<string, unknown> = { ultimo_acesso: new Date().toISOString() };
      if (b.action === "definir_senha") {
        if (u.senha_hash) return json({ error: "Esta matrícula já possui senha." }, 409);
        if (!senhaValida(b.senha)) return json({ error: "A senha deve ter de 8 a 100 caracteres." }, 400);
        if (normMatricula(b.senha) === m) return json({ error: "A senha não pode ser igual à matrícula." }, 400);
        atualizar.senha_hash = await hashSenha(b.senha);
        atualizar.senha_definida_em = new Date().toISOString();
      } else {
        if (!u.senha_hash) return json({ error: "Esta matrícula ainda não tem senha.", sem_senha: true }, 409);
        if (typeof b.senha !== "string" || b.senha.length > 100 || !(await conferirSenha(b.senha, u.senha_hash))) {
          await Promise.all([falhaMatricula(db, m), falhaIp(db, ip)]);
          await espera(1200); // atrasa tentativas erradas
          return json({ error: "Senha incorreta" }, 401);
        }
      }
      const { error: eUp } = await db.from("usuarios").update(atualizar).eq("matricula", m);
      if (eUp) return falha(eUp);   // sem gravar a senha/acesso não se abre sessão
      await limparFalhas(db, "m:" + m);
      const t = await criarToken({ m: u.matricula, n: u.nome });
      return json({ ok: true, nome: u.nome, matricula: u.matricula, token: t.token, exp: t.exp });
    }

    /* ===== 2) Ações com sessão de matrícula ===== */
    if ((b.action === "ler" || b.action === "producao_acesso") && b.token !== undefined) {
      // conferência a cada pedido: se a matrícula for desativada/excluída, ou a senha for redefinida depois do login, o acesso cai na hora
      const s = await sessaoAtiva(db, b.token);
      if (!s) return json({ error: "Sessão inválida ou expirada" }, 401);
      if (b.action === "ler") return await ler(db, b, false);

      // quais produções individuais esta matrícula pode abrir em detalhe (a visão do Setor é de todos)
      const { data: u } = await db.from("usuarios").select("producao_todas").eq("matricula", s.m).maybeSingle();
      if (u?.producao_todas) return json({ ok: true, todas: true, pessoas: [] });
      const { data } = await db.from("usuarios_producao").select("pessoa").eq("matricula", s.m);
      return json({ ok: true, todas: false, pessoas: (data ?? []).map((x: any) => x.pessoa) });
    }

    /* ===== 3) Daqui em diante: exige SENHA_CADASTRO ===== */
    const esperaAdm = await segundosBloqueado(db, "adm:" + ip);
    if (esperaAdm) return tentarDepois(esperaAdm);
    const esperada = Deno.env.get("SENHA_CADASTRO");
    if (!esperada) return json({ error: "SENHA_CADASTRO não configurada no servidor" }, 500);
    if (typeof b.senha !== "string" || b.senha.length > 200 || !igual(b.senha, esperada)) {
      await falhaAdmin(db, ip);
      await espera(1200); // atrasa tentativas erradas
      return json({ error: "Senha incorreta" }, 401);
    }

    switch (b.action) {
      case "verify":
        return json({ ok: true });

      case "ler":
        return await ler(db, b, true);

      /* ---- usuários (matrículas autorizadas) ---- */
      case "usuarios_listar": {
        const { data, error } = await db.from("usuarios").select("matricula, nome, ativo, criado_em, ultimo_acesso, senha_hash, producao_todas").order("nome");
        if (error) return falha(error);
        const { data: lib, error: eLib } = await db.from("usuarios_producao").select("matricula, pessoa").order("pessoa");
        if (eLib) return falha(eLib);
        const porMat = new Map<string, string[]>();
        for (const x of lib ?? []) porMat.set(x.matricula, [...(porMat.get(x.matricula) ?? []), x.pessoa]);
        // o hash nunca sai do servidor: o painel só recebe se a senha existe
        return json({ ok: true, data: (data ?? []).map(({ senha_hash, ...u }: any) => ({ ...u, tem_senha: !!senha_hash, producao_pessoas: porMat.get(u.matricula) ?? [] })) });
      }
      case "producao_pessoas": {   // pessoas que têm produção importada (opções do cadastro de matrículas)
        const { data, error } = await db.from("producao_resumo").select("pessoa").order("pessoa");
        if (error) return falha(error);
        return json({ ok: true, pessoas: (data ?? []).map((x: any) => x.pessoa) });
      }
      case "usuarios_resetar_senha": {   // a pessoa escolherá uma nova senha no próximo acesso
        const m = normMatricula(b.matricula);
        const { error } = await db.from("usuarios").update({ senha_hash: null, senha_definida_em: null }).eq("matricula", m);
        if (error) return falha(error);
        return json({ ok: true });
      }
      case "usuarios_salvar": {
        const m = normMatricula(b.matricula);
        const nome = String(b.nome ?? "").trim().replace(/\s+/g, " ");
        if (!matriculaValida(m)) return json({ error: "Matrícula inválida (use 3 a 30 letras, números, ponto, hífen ou sublinhado)" }, 400);
        if (nome.length < 2 || nome.length > 120) return json({ error: "Informe o nome (2 a 120 caracteres)" }, 400);
        // produção individual liberada: "todas" ou uma lista de pessoas (só nomes que existem na produção importada)
        let nomes: string[] | null = null;
        if (b.producao_pessoas !== undefined) {
          if (!Array.isArray(b.producao_pessoas) || b.producao_pessoas.length > 200) return json({ error: "Lista de produções inválida" }, 400);
          const { data: ex, error: eEx } = await db.from("producao_resumo").select("pessoa");
          if (eEx) return falha(eEx);
          const validas = new Set((ex ?? []).map((x: any) => x.pessoa));
          nomes = [...new Set(b.producao_pessoas.map((x: unknown) => nomePessoa(x)).filter((x: string) => validas.has(x)))] as string[];
        }
        const todas = b.producao_todas === undefined ? undefined : b.producao_todas === true;
        const { data: ja, error: eJa } = await db.from("usuarios").select("matricula").eq("matricula", m).maybeSingle();
        if (eJa) return falha(eJa);
        // matrícula nova nasce SEM nenhuma produção liberada, a menos que o cadastro diga o contrário
        const campos: Record<string, unknown> = { matricula: m, nome };
        if (todas !== undefined) campos.producao_todas = todas; else if (!ja) campos.producao_todas = false;
        const { error } = await db.from("usuarios").upsert(campos, { onConflict: "matricula" });
        if (error) return falha(error);
        if (nomes !== null) {
          const { error: eD } = await db.from("usuarios_producao").delete().eq("matricula", m);
          if (eD) return falha(eD);
          if (nomes.length) {
            const { error: eI } = await db.from("usuarios_producao").insert(nomes.map((pessoa) => ({ matricula: m, pessoa })));
            if (eI) return falha(eI);
          }
        }
        return json({ ok: true });
      }
      case "usuarios_ativar": {
        const m = normMatricula(b.matricula);
        const { error } = await db.from("usuarios").update({ ativo: !!b.ativo }).eq("matricula", m);
        if (error) return falha(error);
        return json({ ok: true });
      }
      case "usuarios_excluir": {
        const m = normMatricula(b.matricula);
        const { error } = await db.from("usuarios").delete().eq("matricula", m);
        if (error) return falha(error);
        return json({ ok: true });
      }

      /* ---- processos ---- */
      case "processos_substituir": {
        const rows = b.rows;
        if (!Array.isArray(rows) || !rows.length || rows.length > 50000) return json({ error: "Lista de processos inválida" }, 400);
        const ts = new Date().toISOString();
        const contAssunto = new Map<string, number>();
        for (const r of rows) { const t = String(r.assunto_principal ?? ""); contAssunto.set(t, (contAssunto.get(t) ?? 0) + 1); }
        const mapaAssunto = mapearAssuntos(contAssunto, await carregarEquivalencias(db));
        const novos = rows.map((r: any) => ({
          numero_processo: String(r.numero_processo ?? ""),
          ...(() => {
            const v = normalizarVara(r.orgao_julgador);
            return { orgao_julgador: v.nome, orgao_original: String(r.orgao_julgador ?? ""), vara_num: v.num, vara_tipo: v.tipo, adjunto: v.adjunto };
          })(),
          dias_chegada: Number.isFinite(r.dias_chegada) ? r.dias_chegada : 0,
          assunto_principal: mapaAssunto.get(String(r.assunto_principal ?? ""))?.final ?? String(r.assunto_principal ?? ""),
          assunto_original: String(r.assunto_principal ?? ""),
          polo_passivo: String(r.polo_passivo ?? ""),
          advogado_polo_ativo: String(r.advogado_polo_ativo ?? ""),
          data_importacao: ts,
        }));
        // base anterior (para calcular entradas e saídas desta importação); falha aqui não impede a importação
        let antigos = new Map<string, string>();
        try { antigos = await lerBaseAtual(db); } catch { /* sem histórico de entradas/saídas nesta importação */ }
        const inserir = async () => {
          for (let i = 0; i < novos.length; i += 500) {
            const { error } = await db.from("processos").insert(novos.slice(i, i + 500));
            if (error) return error;
          }
          return null;
        };
        // 1ª tentativa: inserir os novos e só depois apagar os antigos (não perde dados se falhar)
        let erro = await inserir();
        if (!erro) {
          const { error } = await db.from("processos").delete().neq("data_importacao", ts);
          if (error) return falha(error);
        } else if (erro.code === "23505") {
          // há restrição de unicidade: desfaz o parcial e substitui apagando antes
          await db.from("processos").delete().eq("data_importacao", ts);
          const { error: eDel } = await db.from("processos").delete().neq("id", "00000000-0000-0000-0000-000000000000");
          if (eDel) return falha(eDel);
          erro = await inserir();
          if (erro) return falha(erro);
        } else {
          await db.from("processos").delete().eq("data_importacao", ts);
          return falha(erro);
        }
        let fluxo: { entradas: number | null; saidas: number | null } | null = null;
        try { fluxo = await gravarFoto(db, ts, novos, antigos); } catch (e) { console.error("foto da importação não gravada:", (e as Error).message); }
        return json({ ok: true, total: novos.length, foto: !!fluxo, entradas: fluxo?.entradas ?? null, saidas: fluxo?.saidas ?? null });
      }

      /* ---- assuntos: prévia da unificação (não grava nada) ---- */
      case "assuntos_previa": {
        const lista = Array.isArray(b.assuntos) ? b.assuntos.slice(0, 3000) : [];
        const cont = new Map<string, number>();
        for (const x of lista) { const t = String(x?.texto ?? ""); cont.set(t, (cont.get(t) ?? 0) + (Number(x?.qtd) || 0)); }
        return json(montarPrevia(cont, await carregarEquivalencias(db)));
      }

      /* ---- assuntos: revisão da base já cadastrada (não grava nada) ---- */
      case "assuntos_previa_base": {
        const cont = new Map<string, number>();
        for (let off = 0; ; off += 1000) {
          const { data, error } = await db.from("processos").select("assunto_principal,assunto_original").order("id").range(off, off + 999);
          if (error) return falha(error);
          for (const r of data ?? []) { const t = r.assunto_original ?? r.assunto_principal ?? ""; cont.set(t, (cont.get(t) ?? 0) + 1); }
          if (!data || data.length < 1000) break;
        }
        return json(montarPrevia(cont, await carregarEquivalencias(db)));
      }

      /* ---- assuntos: salva regras confirmadas pelo usuário ---- */
      case "assuntos_equivalencias_salvar": {
        const grupos = Array.isArray(b.grupos) ? b.grupos.slice(0, 200) : [];
        const linhas = new Map<string, { chave: string; canonico: string; exemplo: string }>();
        for (const g of grupos) {
          const canonico = String(g?.canonico ?? "").trim().slice(0, 300);
          if (!canonico || !Array.isArray(g?.variantes)) continue;
          linhas.set(chaveAssunto(canonico), { chave: chaveAssunto(canonico), canonico, exemplo: canonico });   // âncora: o próprio nome final
          for (const v of g.variantes.slice(0, 100)) {
            const texto = String(v ?? "").trim().slice(0, 300);
            const k = chaveAssunto(texto);
            if (texto && k && k !== chaveAssunto(canonico)) linhas.set(k, { chave: k, canonico, exemplo: texto });
          }
        }
        if (!linhas.size) return json({ error: "Nenhuma unificação válida informada" }, 400);
        const { error } = await db.from("assuntos_equivalencias").upsert([...linhas.values()], { onConflict: "chave" });
        if (error) return falha(error);
        return json({ ok: true, regras: linhas.size });
      }

      case "assuntos_equivalencias_listar": {
        const { data, error } = await db.from("assuntos_equivalencias").select("chave,canonico,exemplo,criado_em").order("canonico");
        if (error) return falha(error);
        return json({ ok: true, data: (data ?? []).filter((r: any) => chaveAssunto(r.canonico) !== r.chave) });   // esconde as âncoras
      }

      case "assuntos_equivalencias_excluir": {
        const chave = String(b.chave ?? "");
        if (!chave) return json({ error: "Regra inválida" }, 400);
        const { error } = await db.from("assuntos_equivalencias").delete().eq("chave", chave);
        if (error) return falha(error);
        return json({ ok: true });
      }

      /* ---- prévia da unificação (não grava nada) ---- */
      case "processos_previa": {
        const un = Array.isArray(b.unidades) ? b.unidades.slice(0, 1000) : [];
        const linhas = un.map((u: any) => {
          const info = normalizarVara(u.texto);
          return { texto: String(u.texto ?? ""), qtd: Number(u.qtd) || 0, nome: info.nome, num: info.num, tipo: info.tipo, adjunto: info.adjunto, aviso: info.aviso };
        });
        const porVara = new Map<string, { nome: string; num: number | null; total: number; adjuntos: number; textos: number }>();
        for (const l of linhas) {
          const v = porVara.get(l.nome) ?? { nome: l.nome, num: l.num, total: 0, adjuntos: 0, textos: 0 };
          v.total += l.qtd; v.textos += 1; if (l.adjunto) v.adjuntos += l.qtd;
          porVara.set(l.nome, v);
        }
        linhas.sort((x: any, y: any) => ((x.num ?? 999) - (y.num ?? 999)) || (x.adjunto === y.adjunto ? x.texto.localeCompare(y.texto) : x.adjunto ? 1 : -1));
        const varas = [...porVara.values()].sort((x, y) => ((x.num ?? 999) - (y.num ?? 999)) || x.nome.localeCompare(y.nome));
        return json({ ok: true, linhas, varas, unificar_adjuntos: UNIFICAR_ADJUNTOS });
      }

      /* ---- reaplica a unificação nos processos já cadastrados ---- */
      case "processos_renormalizar": {
        const origens = new Set<string>();
        const paresAssunto = new Map<string, { src: string; atual: string; tinhaOriginal: boolean }>();
        const contAssuntoBase = new Map<string, number>();
        let total = 0;
        for (let off = 0; ; off += 1000) {
          const { data, error } = await db.from("processos").select("orgao_julgador,orgao_original,assunto_principal,assunto_original").order("id").range(off, off + 999);
          if (error) return falha(error);
          for (const r of data ?? []) {
            origens.add(r.orgao_original ?? r.orgao_julgador ?? ""); total++;
            const srcA = r.assunto_original ?? r.assunto_principal ?? "";
            const chaveA = `${srcA}\u0001${r.assunto_principal ?? ""}`;
            if (!paresAssunto.has(chaveA)) paresAssunto.set(chaveA, { src: srcA, atual: r.assunto_principal ?? "", tinhaOriginal: r.assunto_original != null });
            contAssuntoBase.set(srcA, (contAssuntoBase.get(srcA) ?? 0) + 1);
          }
          if (!data || data.length < 1000) break;
        }
        for (const src of origens) {
          const v = normalizarVara(src);
          const campos = { orgao_julgador: v.nome, orgao_original: src, vara_num: v.num, vara_tipo: v.tipo, adjunto: v.adjunto };
          const { error: e1 } = await db.from("processos").update(campos).eq("orgao_original", src);
          if (e1) return falha(e1);
          const { error: e2 } = await db.from("processos").update(campos).is("orgao_original", null).eq("orgao_julgador", src);
          if (e2) return falha(e2);
        }
        // assuntos: aplica as regras e a unificação automática; só atualiza o que realmente muda
        const mapaBase = mapearAssuntos(contAssuntoBase, await carregarEquivalencias(db));
        let assuntosAlterados = 0;
        for (const { src, atual, tinhaOriginal } of paresAssunto.values()) {
          const novoFinal = mapaBase.get(src)?.final ?? src;
          if (novoFinal === atual) continue;
          const campos = { assunto_principal: novoFinal, assunto_original: src };
          const q1 = tinhaOriginal
            ? db.from("processos").update(campos).eq("assunto_original", src).eq("assunto_principal", atual)
            : db.from("processos").update(campos).is("assunto_original", null).eq("assunto_principal", atual);
          const { error: eA } = await q1;
          if (eA) return falha(eA);
          assuntosAlterados++;
        }
        return json({ ok: true, processos: total, textos_distintos: origens.size, assuntos_unificados: assuntosAlterados });
      }

      case "processos_excluir_todos": {
        const { error } = await db.from("processos").delete().neq("id", "00000000-0000-0000-0000-000000000000");
        if (error) return falha(error);
        return json({ ok: true });
      }

      case "prazos_salvar": {
        const p = b.prazos ?? {};
        const mapa: Record<string, number> = {
          prazo_normal_max: p.normal_max, prazo_atencao_max: p.atencao_max, prazo_atrasado_min: p.atrasado_min,
        };
        const v = Object.values(mapa);
        if (!v.every((x) => Number.isInteger(x) && x > 0 && x <= 365) || !(v[0] < v[1] && v[1] < v[2]))
          return json({ error: "Valores inválidos: use inteiros crescentes (Normal < Atenção < Atrasado)" }, 400);
        // limite da linha "Acima de X dias" no topo de cada assunto (opcional; independe da classificação normal/atenção/atrasado)
        const destaque = p.destaque_assunto;
        if (destaque !== undefined && (!Number.isInteger(destaque) || destaque < 1 || destaque > 3650))
          return json({ error: "Valor inválido para a lista de assuntos: use um número inteiro de 1 a 3650 dias" }, 400);
        const gravar: [string, number, string | null][] = Object.entries(mapa).map(([k, v]) => [k, v, null]);
        if (destaque !== undefined) gravar.push(["prazo_destaque_assunto", destaque, "Dias a partir dos quais o processo entra na linha 'Acima de X dias' de cada assunto (Análise)"]);
        for (const [chave, valor, descricao] of gravar) {
          const { data, error } = await db.from("configuracoes").update({ valor: String(valor), atualizado_em: new Date().toISOString() }).eq("chave", chave).select("id");
          if (error) return falha(error);
          if (!data?.length) {
            const { error: e2 } = await db.from("configuracoes").insert(descricao ? { chave, valor: String(valor), descricao } : { chave, valor: String(valor) });
            if (e2) return falha(e2);
          }
        }
        return json({ ok: true });
      }

      case "periodo_salvar": {
        const { meses, labels, varas, jef } = b;
        const n = Array.isArray(meses) ? meses.length : 0;
        if (!n || n > 240 || !meses.every((m: unknown) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m)))
          return json({ error: "Meses inválidos" }, 400);
        if (!Array.isArray(labels) || labels.length !== n) return json({ error: "Rótulos inválidos" }, 400);
        for (const aba of [varas, jef]) for (const c of CAMPOS) if (!nums(aba?.[c], n)) return json({ error: `Dados inválidos (${c})` }, 400);
        const nome = String(b.nome_periodo || `Período ${labels[0]} - ${labels[n - 1]} (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })})`);
        const { data: per, error } = await db.from("config_periodos").insert({ nome_periodo: nome, meses, labels, total_meses: n }).select("id").single();
        if (error) return falha(error);
        const linhas = CAMPOS.flatMap((c) => [
          { periodo_id: per.id, aba: "varas", tipo: c, valores: varas[c] },
          { periodo_id: per.id, aba: "jef", tipo: c, valores: jef[c] },
        ]);
        const { error: e2 } = await db.from("dados_processos").insert(linhas);
        if (e2) { await db.from("config_periodos").delete().eq("id", per.id); return falha(e2); }
        return json({ ok: true, id: per.id });
      }

      case "periodo_excluir": {
        const id = Number(b.id);
        if (!Number.isInteger(id)) return json({ error: "ID inválido" }, 400);
        const { error: e1 } = await db.from("dados_processos").delete().eq("periodo_id", id);
        if (e1) return falha(e1);
        const { error: e2 } = await db.from("config_periodos").delete().eq("id", id);
        if (e2) return falha(e2);
        return json({ ok: true });
      }

      /* ---- Produção Individual ---- */
      case "producao_lote": {   // recebe um pedaço das linhas de uma pessoa (a importação é feita em lotes)
        const pessoa = nomePessoa(b.pessoa);
        const ts = String(b.ts ?? "");
        if (!pessoa || !/^\d{4}-\d{2}-\d{2}T/.test(ts) || Number.isNaN(Date.parse(ts))) return json({ error: "Pessoa ou carimbo da importação inválidos" }, 400);
        const rows = b.rows;
        if (!Array.isArray(rows) || !rows.length || rows.length > 3000) return json({ error: "Lote inválido" }, 400);
        const corte = primeiroDiaMesAtual();
        const lim = (x: unknown, n: number) => { const t = String(x ?? "").trim().slice(0, n); return t || null; };
        const dia = (x: unknown) => {   // só datas que existem no calendário (rejeita mês 15, 30/02 etc. sem derrubar o lote)
          if (typeof x !== "string" || !ISO.test(x)) return null;
          const t = Date.parse(x + "T00:00:00Z");
          return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== x ? null : x;
        };
        const ok: any[] = []; let ignoradas = 0;
        for (const r of rows) {
          const data = dia(r.data), processo = lim(r.processo, 80);
          if (!data || !processo || data >= corte || data < "2000-01-01") { ignoradas++; continue; }
          ok.push({ pessoa, data, processo, objeto: lim(r.objeto, 200), prioridade: lim(r.prioridade, 60), observacao: lim(r.observacao, 300), recebido_em: dia(r.recebido_em), tipo: lim(r.tipo, 20)?.toUpperCase() ?? null, importado_em: ts });
        }
        if (ok.length) { const { error } = await db.from("producao_itens").insert(ok); if (error) return falha(error); }
        return json({ ok: true, gravadas: ok.length, ignoradas });
      }

      case "producao_finalizar": {   // troca os dados antigos da pessoa pelos novos e recalcula o resumo
        const pessoa = nomePessoa(b.pessoa), ts = String(b.ts ?? "");
        if (!pessoa || Number.isNaN(Date.parse(ts))) return json({ error: "Pessoa ou carimbo da importação inválidos" }, 400);
        const { count, error: eC } = await db.from("producao_itens").select("id", { count: "exact", head: true }).eq("pessoa", pessoa).eq("importado_em", ts);
        if (eC) return falha(eC);
        if (!count) return json({ error: "Nenhuma linha válida recebida para esta pessoa; os dados antigos foram mantidos" }, 400);
        // 1) calcula o resumo só com a importação nova; 2) só então apaga a antiga (se algo falhar, nada se perde)
        const total = await recalcularPessoa(db, pessoa, String(b.arquivo ?? "").slice(0, 200) || null, ts);
        const { error: eD } = await db.from("producao_itens").delete().eq("pessoa", pessoa).neq("importado_em", ts);
        if (eD) return falha(eD);
        return json({ ok: true, total });
      }

      case "producao_cancelar": {   // importação que falhou no meio: descarta só o que chegou nela
        const pessoa = nomePessoa(b.pessoa), ts = String(b.ts ?? "");
        if (!pessoa || Number.isNaN(Date.parse(ts))) return json({ error: "Pedido inválido" }, 400);
        const { error } = await db.from("producao_itens").delete().eq("pessoa", pessoa).eq("importado_em", ts);
        if (error) return falha(error);
        return json({ ok: true });
      }

      case "producao_recalcular": {   // refaz os resumos de todos (depois de mudar as regras de assunto)
        const { data, error } = await db.from("producao_resumo").select("pessoa");
        if (error) return falha(error);
        let n = 0;
        for (const r of data ?? []) { await recalcularPessoa(db, r.pessoa); n++; }
        return json({ ok: true, pessoas: n });
      }

      case "calendario_salvar": {   // substitui o calendário de ausências inteiro (e guarda a correspondência de nomes)
        const pessoas = Array.isArray(b.pessoas) ? b.pessoas.slice(0, 80) : [];
        if (!pessoas.length) return json({ error: "Nenhuma pessoa com dados no calendário" }, 400);
        const { data: existentes, error: eR } = await db.from("producao_resumo").select("pessoa");
        if (eR) return falha(eR);
        const validas = new Set((existentes ?? []).map((x: any) => x.pessoa));
        const arquivo = String(b.arquivo ?? "").slice(0, 200) || null;
        const linhas: any[] = [];
        for (const p of pessoas) {
          const nome = nomePessoa(p?.pessoa);
          if (!validas.has(nome)) continue;   // só pessoas que já têm produção importada
          const m = limparCalendario(p?.dados);
          if (!Object.keys(m).length) continue;
          linhas.push({ pessoa: nome, dados: { m }, arquivo, atualizado_em: new Date().toISOString() });
        }
        if (!linhas.length) return json({ error: "Nenhuma pessoa do calendário corresponde a uma pessoa da produção importada" }, 400);
        const { error: eU } = await db.from("producao_calendario").upsert(linhas, { onConflict: "pessoa" });
        if (eU) return falha(eU);
        const novas = new Set(linhas.map((l) => l.pessoa));
        const { data: antigas, error: eA } = await db.from("producao_calendario").select("pessoa");
        if (eA) return falha(eA);
        for (const a of antigas ?? []) if (!novas.has(a.pessoa)) await db.from("producao_calendario").delete().eq("pessoa", a.pessoa);
        // correspondência de nomes (substitui a anterior)
        const apelidos = (Array.isArray(b.apelidos) ? b.apelidos.slice(0, 300) : []).map((a: any) => ({
          chave: chaveNomeCal(a?.nome), nome: String(a?.nome ?? "").trim().slice(0, 80), pessoa: validas.has(nomePessoa(a?.pessoa)) ? nomePessoa(a?.pessoa) : null,
        })).filter((a: any) => a.chave);
        await db.from("producao_apelidos").delete().neq("chave", "");
        if (apelidos.length) { const { error: eP } = await db.from("producao_apelidos").insert(apelidos); if (eP) return falha(eP); }
        return json({ ok: true, pessoas: linhas.length });
      }

      case "calendario_excluir": {
        const { error: e1 } = await db.from("producao_calendario").delete().neq("pessoa", "");
        if (e1) return falha(e1);
        return json({ ok: true });
      }

      case "producao_excluir_pessoa": {
        const pessoa = nomePessoa(b.pessoa);
        if (!pessoa) return json({ error: "Pessoa inválida" }, 400);
        const { error: e1 } = await db.from("producao_itens").delete().eq("pessoa", pessoa);
        if (e1) return falha(e1);
        const { error: e2 } = await db.from("producao_resumo").delete().eq("pessoa", pessoa);
        if (e2) return falha(e2);
        await db.from("producao_calendario").delete().eq("pessoa", pessoa);
        await db.from("usuarios_producao").delete().eq("pessoa", pessoa);   // some também das liberações de acesso
        return json({ ok: true });
      }

      default:
        return json({ error: "Ação desconhecida" }, 400);
    }
  } catch (e) {
    return falha(e);
  }
});
