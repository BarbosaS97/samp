// Configuração única do SAMP, compartilhada por todos os módulos.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://vdsuugrouxxcstooiafa.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkc3V1Z3JvdXh4Y3N0b29pYWZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODUzODAsImV4cCI6MjA5MTc2MTM4MH0.zsmuOK6F9KFM78lrS8lXdqx_W6q44CqRgZGWQ12UswI'
};
window.APP_CONFIG.FUNCTION_URL = window.APP_CONFIG.SUPABASE_URL + '/functions/v1/cadastros-function';

/* ---------- Sessão do usuário (matrícula autorizada) ---------- */
window.SAMP_AUTH = (function () {
  const CHAVE = 'samp_sessao';
  function get() {
    try {
      const s = JSON.parse(sessionStorage.getItem(CHAVE) || 'null');
      return s && s.token && s.exp > Date.now() ? s : null;
    } catch (e) { return null; }
  }
  function set(s) { try { sessionStorage.setItem(CHAVE, JSON.stringify(s)); } catch (e) {} }
  function sair(irParaLogin) {   // usado quando o servidor recusa a sessão (expirada ou matrícula bloqueada)
    try { sessionStorage.removeItem(CHAVE); } catch (e) {}
    if (irParaLogin !== false) irLogin('expirou');
  }
  function irLogin(motivo) {
    const volta = location.pathname.split('/').pop() || 'index.html';
    location.replace('entrar.html?volta=' + encodeURIComponent(volta) + (motivo === 'expirou' ? '&expirou=1' : ''));
  }
  return { get, set, sair, irLogin };
})();

/* ---------- Chamada à função do servidor ---------- */
window.chamarSAMP = async function (corpo) {
  const { FUNCTION_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
  const r = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    body: JSON.stringify(corpo)
  });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error(j.error || ('Erro ' + r.status)); err.status = r.status; throw err; }
  return j;
};

/* ---------- Cliente SOMENTE LEITURA ----------
   Imita o formato from(tabela).select().eq().order().range()..., mas cada consulta é enviada
   ao servidor, que confere a matrícula (ou a senha de cadastro) antes de devolver os dados.
   Não existe insert/update/delete/rpc neste objeto: toda escrita é feita só no Cadastros. */
window.criarClienteLeitura = function (opcoes) {
  opcoes = opcoes || {};   // { senha: () => 'senha de cadastro' } usado só pelo Cadastros
  async function executar(spec) {
    const corpo = { action: 'ler', ...spec };
    if (opcoes.senha) corpo.senha = opcoes.senha();
    else { const s = window.SAMP_AUTH.get(); if (!s) { window.SAMP_AUTH.irLogin(); return { data: null, error: { message: 'Sessão expirada' } }; } corpo.token = s.token; }
    try {
      const j = await window.chamarSAMP(corpo);
      return { data: j.data ?? null, count: j.count ?? null, error: null };
    } catch (e) {
      if (e.status === 401 && !opcoes.senha) window.SAMP_AUTH.sair();
      return { data: null, count: null, error: { message: e.message } };
    }
  }
  function from(tabela) {
    const spec = { table: tabela, eq: {} };
    const b = {
      select(colunas, o) { spec.select = colunas || '*'; if (o && o.count) { spec.count = true; spec.head = !!o.head; } return b; },
      eq(col, val) { spec.eq[col] = val; return b; },
      order(col, o) { spec.order = { col, asc: !(o && o.ascending === false) }; return b; },
      range(de, ate) { spec.range = [de, ate]; return b; },
      limit(n) { spec.limit = n; return b; },
      single() { spec.single = true; return b; },
      then(ok, falha) { return executar(spec).then(ok, falha); }
    };
    return b;
  }
  return Object.freeze({ from });
};

/* ---------- Data e hora no horário de Brasília ----------
   O banco guarda os instantes em UTC e, em algumas colunas, sem indicar o fuso ("2026-10-07T18:43:00"). Se o navegador lesse isso
   como hora local, mostraria 3 horas a mais. Esta função trata o valor sem fuso como UTC e exibe sempre em America/Sao_Paulo. */
window.formatarDataHora = function (valor, curto) {
  if (!valor) return '-';
  let t = String(valor);
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', curto ? { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' } : { timeZone: 'America/Sao_Paulo' });
};
