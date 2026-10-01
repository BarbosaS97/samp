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
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

function igual(a: string, b: string) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}

const CAMPOS = ["recebidos", "calculados", "acervo", "tempo"];
const TABELAS = ["processos", "configuracoes", "config_periodos", "dados_processos"];
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
  const corpo = b64u(enc.encode(JSON.stringify({ ...dados, exp: Date.now() + SESSAO_MS })));
  const sig = b64u(await crypto.subtle.sign("HMAC", await chave(), enc.encode(corpo)));
  return { token: `${corpo}.${sig}`, exp: Date.now() + SESSAO_MS };
}
async function lerToken(token: unknown): Promise<{ m: string; n: string } | null> {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [corpo, sig] = token.split(".");
  if (!corpo || !sig) return null;
  const esperado = b64u(await crypto.subtle.sign("HMAC", await chave(), enc.encode(corpo)));
  if (!igual(sig, esperado)) return null;
  try {
    const d = JSON.parse(dec.decode(deb64u(corpo)));
    return d.exp > Date.now() ? { m: d.m, n: d.n } : null;
  } catch { return null; }
}

/* ---------- leitura controlada ---------- */
async function ler(db: any, q: any, admin: boolean) {
  const tabela = q.table;
  if (!(TABELAS.includes(tabela) || (admin && tabela === "usuarios"))) return json({ error: "Tabela não permitida" }, 400);
  const cols = typeof q.select === "string" && /^[a-zA-Z_*, ]+$/.test(q.select) ? q.select : "*";
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
  if (error) return json({ error: error.message }, 500);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Requisição inválida" }, 400); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const falha = (e: any) => json({ error: e?.message ?? String(e) }, 500);

  try {
    /* ===== 1) Login por matrícula (sem senha) ===== */
    if (b.action === "login") {
      const m = normMatricula(b.matricula);
      const { data: u } = matriculaValida(m)
        ? await db.from("usuarios").select("matricula, nome, ativo").eq("matricula", m).maybeSingle()
        : { data: null };
      if (!u || !u.ativo) { await espera(900); return json({ error: "Matrícula não autorizada" }, 401); }
      await db.from("usuarios").update({ ultimo_acesso: new Date().toISOString() }).eq("matricula", m);
      const t = await criarToken({ m: u.matricula, n: u.nome });
      return json({ ok: true, nome: u.nome, matricula: u.matricula, token: t.token, exp: t.exp });
    }

    /* ===== 2) Leitura com sessão de matrícula ===== */
    if (b.action === "ler" && b.token !== undefined) {
      const s = await lerToken(b.token);
      if (!s) return json({ error: "Sessão inválida ou expirada" }, 401);
      // conferência a cada leitura: se a matrícula for desativada/excluída, o acesso cai na hora
      const { data: u } = await db.from("usuarios").select("ativo").eq("matricula", s.m).maybeSingle();
      if (!u?.ativo) return json({ error: "Matrícula não autorizada" }, 401);
      return await ler(db, b, false);
    }

    /* ===== 3) Daqui em diante: exige SENHA_CADASTRO ===== */
    const esperada = Deno.env.get("SENHA_CADASTRO");
    if (!esperada) return json({ error: "SENHA_CADASTRO não configurada no servidor" }, 500);
    if (typeof b.senha !== "string" || !igual(b.senha, esperada)) {
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
        const { data, error } = await db.from("usuarios").select("*").order("nome");
        if (error) return falha(error);
        return json({ ok: true, data });
      }
      case "usuarios_salvar": {
        const m = normMatricula(b.matricula);
        const nome = String(b.nome ?? "").trim().replace(/\s+/g, " ");
        if (!matriculaValida(m)) return json({ error: "Matrícula inválida (use 3 a 30 letras, números, ponto, hífen ou sublinhado)" }, 400);
        if (nome.length < 2 || nome.length > 120) return json({ error: "Informe o nome (2 a 120 caracteres)" }, 400);
        const { error } = await db.from("usuarios").upsert({ matricula: m, nome }, { onConflict: "matricula" });
        if (error) return falha(error);
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
        const novos = rows.map((r: any) => ({
          numero_processo: String(r.numero_processo ?? ""),
          ...(() => {
            const v = normalizarVara(r.orgao_julgador);
            return { orgao_julgador: v.nome, orgao_original: String(r.orgao_julgador ?? ""), vara_num: v.num, vara_tipo: v.tipo, adjunto: v.adjunto };
          })(),
          dias_chegada: Number.isFinite(r.dias_chegada) ? r.dias_chegada : 0,
          assunto_principal: String(r.assunto_principal ?? ""),
          polo_passivo: String(r.polo_passivo ?? ""),
          advogado_polo_ativo: String(r.advogado_polo_ativo ?? ""),
          data_importacao: ts,
        }));
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
        return json({ ok: true, total: novos.length });
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
        let total = 0;
        for (let off = 0; ; off += 1000) {
          const { data, error } = await db.from("processos").select("orgao_julgador,orgao_original").order("id").range(off, off + 999);
          if (error) return falha(error);
          for (const r of data ?? []) { origens.add(r.orgao_original ?? r.orgao_julgador ?? ""); total++; }
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
        return json({ ok: true, processos: total, textos_distintos: origens.size });
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
        for (const [chave, valor] of Object.entries(mapa)) {
          const { data, error } = await db.from("configuracoes").update({ valor: String(valor), atualizado_em: new Date().toISOString() }).eq("chave", chave).select("id");
          if (error) return falha(error);
          if (!data?.length) {
            const { error: e2 } = await db.from("configuracoes").insert({ chave, valor: String(valor) });
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

      default:
        return json({ error: "Ação desconhecida" }, 400);
    }
  } catch (e) {
    return falha(e);
  }
});
