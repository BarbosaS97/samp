// Sampinha - assistente de IA e orquestradora do SAMP (interface do chat).
// Usa a sessão da matrícula e conversa com a função "sampinha-function". Consulta dados, gera relatórios (PDF/CSV)
// e executa ações de navegação na tela; nunca altera dados.
// O histórico de conversas fica salvo no banco, por matrícula (acessível de qualquer computador).
(function () {
  const usuario = window.SAMP_USUARIO;
  const pagina = document.body.dataset.page;
  if (!usuario || !window.APP_CONFIG) return;

  const SUGESTOES = {
    analise: [
      'Dê um resumo geral da base de processos',
      'Liste 5 processos com o mesmo assunto e o mesmo advogado',
      'Quais processos estão atrasados?',
      'Quais advogados têm mais processos?'
    ],
    metricas: [
      'Resuma o desempenho do período mais recente',
      'Compare Varas Comuns e JEF',
      'Em que mês o acervo foi maior?',
      'Qual a média de calculados nos últimos 6 meses?'
    ]
  };

  // Histórico antigo guardado no navegador (versão anterior): removido, agora fica no servidor.
  try { localStorage.removeItem('sampinha_conv_' + usuario.matricula); } catch (e) {}

  /* ---------- estado ---------- */
  let atualId = null;          // conversa aberta (vive no banco)
  let mensagens = [];          // mensagens da conversa aberta [{role, content}]
  let ocupado = false;
  let tempoBusca = null, seqLista = 0;
  try { atualId = sessionStorage.getItem('sampinha_ativa') || null; } catch (e) {}
  const guardarAtiva = () => { try { sessionStorage.setItem('sampinha_ativa', atualId || ''); } catch (e) {} };

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- chamada ao servidor ---------- */
  async function api(corpo) {
    const sessao = window.SAMP_AUTH.get();
    if (!sessao) { window.SAMP_AUTH.irLogin(); throw new Error('Sessão expirada'); }
    const r = await fetch(window.APP_CONFIG.SUPABASE_URL + '/functions/v1/sampinha-function', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: window.APP_CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + window.APP_CONFIG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ token: sessao.token, modulo: pagina, ...corpo })
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401) { window.SAMP_AUTH.sair(); throw new Error('Sessão expirada'); }
    if (!r.ok) { const err = new Error(j.error || ('Erro ' + r.status)); err.status = r.status; throw err; }
    return j;
  }
  const msgErro = (e) => (e.message === 'Failed to fetch' ? 'Não consegui contatar o servidor. Tente novamente.' : e.message);

  /* ---------- estrutura ---------- */
  const botao = el('button', 'sp-fab', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg><span>Sampinha</span>');
  botao.type = 'button'; botao.setAttribute('aria-label', 'Abrir a Sampinha, assistente do SAMP');

  const painel = el('section', 'sp-panel');
  painel.setAttribute('role', 'dialog'); painel.setAttribute('aria-label', 'Sampinha - assistente do SAMP'); painel.hidden = true;
  painel.innerHTML =
    '<header class="sp-head"><div class="sp-titulo"><strong>Sampinha</strong><small>Assistente de IA do SAMP</small></div>' +
    '<div class="sp-actions"><button type="button" class="sp-hbtn sp-bhist" title="Histórico de conversas">Histórico</button>' +
    '<button type="button" class="sp-hbtn sp-bnova" title="Nova conversa">+ Nova</button>' +
    '<button type="button" class="sp-x" aria-label="Fechar">&times;</button></div></header>' +
    '<div class="sp-hist" hidden>' +
      '<div class="sp-hist-top"><input type="search" class="sp-busca" placeholder="Buscar nas conversas..." aria-label="Buscar nas conversas"><button type="button" class="sp-limpar">Limpar tudo</button></div>' +
      '<div class="sp-hist-lista"></div>' +
    '</div>' +
    '<div class="sp-msgs" aria-live="polite"></div>' +
    '<div class="sp-chips"></div>' +
    '<form class="sp-form"><textarea rows="1" placeholder="Pergunte sobre os processos ou as metas..." maxlength="1500" aria-label="Sua pergunta"></textarea>' +
    '<button type="submit" class="sp-send" aria-label="Enviar">Enviar</button></form>' +
    '<div class="sp-aviso">A Sampinha usa IA e pode errar: confira os dados importantes. As perguntas e os dados consultados são processados por um serviço externo de IA. O histórico fica salvo no sistema e só você o vê.</div>';

  document.body.append(botao, painel);
  const q = (s) => painel.querySelector(s);
  const $msgs = q('.sp-msgs'), $chips = q('.sp-chips'), $form = q('.sp-form'), $txt = q('textarea'), $send = q('.sp-send'),
        $hist = q('.sp-hist'), $lista = q('.sp-hist-lista'), $busca = q('.sp-busca'), $aviso = q('.sp-aviso'),
        $bHist = q('.sp-bhist'), $bNova = q('.sp-bnova');

  /* ---------- renderização das mensagens ---------- */
  const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
  function formatar(texto) {
    const linhas = esc(texto).split('\n');
    let html = '', lista = false;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(RX_PROC, (n) => `<button type="button" class="sp-proc" data-n="${n}" title="Copiar número">${n}</button>`);
    for (const l of linhas) {
      const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) { if (!lista) { html += '<ul>'; lista = true; } html += `<li>${inline(m[1])}</li>`; }
      else { if (lista) { html += '</ul>'; lista = false; } if (l.trim()) html += `<p>${inline(l)}</p>`; }
    }
    return html + (lista ? '</ul>' : '');
  }
  function separarSugestoes(texto) {
    const m = texto.match(/\n?\s*SUGEST(?:Õ|O)ES:\s*(.+)\s*$/i);
    if (!m) return { corpo: texto, sugestoes: [] };
    return { corpo: texto.slice(0, m.index).trim(), sugestoes: m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3) };
  }
  function bolha(papel, texto) {
    const b = el('div', 'sp-msg sp-' + papel, papel === 'user' ? `<p>${esc(texto)}</p>` : formatar(texto));
    $msgs.appendChild(b); $msgs.scrollTop = $msgs.scrollHeight; return b;
  }
  function mostrarChips(lista) {
    $chips.innerHTML = '';
    lista.forEach((s) => { const c = el('button', 'sp-chip'); c.type = 'button'; c.textContent = s; c.onclick = () => enviar(s); $chips.appendChild(c); });
  }
  function boasVindas() {
    mensagens = []; $msgs.innerHTML = '';
    bolha('bot', `Olá, ${usuario.nome.split(' ')[0]}! Eu sou a Sampinha. Posso consultar os dados do SAMP e responder perguntas sobre os processos e as metas processuais. Veja alguns exemplos ou escreva a sua pergunta.`);
    mostrarChips(SUGESTOES[pagina] || SUGESTOES.analise);
  }
  function desenharMensagens() {
    $msgs.innerHTML = '';
    let ultimas = [];
    mensagens.forEach((m) => {
      if (m.role === 'user') bolha('user', m.content);
      else { const s = separarSugestoes(m.content); const b = bolha('bot', s.corpo); if (m.anexo && m.anexo.relatorio) anexarRelatorio(b, m.anexo.relatorio); ultimas = s.sugestoes; }
    });
    mostrarChips(ultimas);
  }
  async function carregarConversa(id) {
    $msgs.innerHTML = ''; $chips.innerHTML = '';
    const espera = bolha('bot', ''); espera.classList.add('sp-wait'); espera.textContent = 'Carregando a conversa...';
    try {
      const j = await api({ action: 'abrir', id });
      if (id !== atualId) return;
      mensagens = j.mensagens; desenharMensagens();
    } catch (e) {
      if (id !== atualId) return;
      atualId = null; guardarAtiva(); boasVindas();   // conversa inexistente ou apagada
    }
  }

  /* ---------- histórico ---------- */
  const diaDe = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const difDias = (ts) => Math.round((diaDe(new Date()) - diaDe(new Date(ts))) / 86400000);
  function rotuloData(ts) {
    const d = new Date(ts), dif = difDias(ts);
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return (dif === 0 ? 'Hoje' : dif === 1 ? 'Ontem' : d.toLocaleDateString('pt-BR')) + ', ' + hora;
  }
  const grupoDe = (ts) => { const dif = difDias(ts); return dif === 0 ? 'Hoje' : dif === 1 ? 'Ontem' : dif <= 7 ? 'Últimos 7 dias' : 'Anteriores'; };

  let ultimaLista = [];
  async function atualizarHistorico() {
    const minha = ++seqLista;
    $lista.innerHTML = '<p class="sp-vazio">Carregando...</p>';
    try {
      const j = await api({ action: 'listar', q: $busca.value.trim() });
      if (minha !== seqLista) return;
      ultimaLista = j.conversas || [];
      desenharHistorico();
    } catch (e) { if (minha === seqLista) $lista.innerHTML = `<p class="sp-vazio">${esc(msgErro(e))}</p>`; }
  }
  function desenharHistorico() {
    if (!ultimaLista.length) { $lista.innerHTML = `<p class="sp-vazio">${$busca.value.trim() ? 'Nenhuma conversa encontrada.' : 'Ainda não há conversas salvas.'}</p>`; return; }
    let html = '', grupo = '';
    ultimaLista.forEach((c) => {
      const g = grupoDe(c.atualizada_em);
      if (g !== grupo) { html += `<div class="sp-grupo">${g}</div>`; grupo = g; }
      html += `<div class="sp-item${c.id === atualId ? ' sp-ativa' : ''}" data-id="${c.id}" role="button" tabindex="0">` +
        `<div class="sp-item-t"><span>${esc(c.titulo)}</span><small>${rotuloData(c.atualizada_em)}</small></div>` +
        `<button type="button" class="sp-del" data-del="${c.id}" aria-label="Excluir conversa" title="Excluir">&times;</button></div>`;
    });
    $lista.innerHTML = html;
  }
  function modoHistorico(ligado) {
    $hist.hidden = !ligado;
    $msgs.hidden = $chips.hidden = $form.hidden = $aviso.hidden = ligado;
    $bHist.classList.toggle('sp-on', ligado);
    if (ligado) { $busca.value = ''; atualizarHistorico(); $busca.focus(); }
  }
  function abrirConversa(id) {
    if (ocupado) return;
    atualId = id; guardarAtiva(); modoHistorico(false); carregarConversa(id); $txt.focus();
  }
  function novaConversa() {
    if (ocupado) return;
    atualId = null; guardarAtiva(); modoHistorico(false); boasVindas(); $txt.focus();
  }
  $bHist.onclick = () => { if (!ocupado) modoHistorico($hist.hidden); };
  $bNova.onclick = novaConversa;
  $busca.addEventListener('input', () => { clearTimeout(tempoBusca); tempoBusca = setTimeout(atualizarHistorico, 300); });
  $lista.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del, c = ultimaLista.find((x) => x.id === id);
      if (!c || !confirm(`Excluir a conversa "${c.titulo}"?`)) return;
      try {
        await api({ action: 'excluir', id });
        if (atualId === id) { atualId = null; guardarAtiva(); mensagens = []; }
        atualizarHistorico();
      } catch (err) { alert(msgErro(err)); }
      return;
    }
    const it = e.target.closest('.sp-item'); if (it) abrirConversa(it.dataset.id);
  });
  $lista.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const it = e.target.closest('.sp-item'); if (it) abrirConversa(it.dataset.id); } });
  q('.sp-limpar').onclick = async () => {
    if (!ultimaLista.length || !confirm('Excluir TODAS as suas conversas salvas? Esta ação não pode ser desfeita.')) return;
    try { await api({ action: 'excluir_todas' }); atualId = null; guardarAtiva(); mensagens = []; atualizarHistorico(); }
    catch (err) { alert(msgErro(err)); }
  };

  /* ---------- envio ---------- */
  function bloquear(v) { ocupado = v; $send.disabled = v; $txt.disabled = v; $bHist.disabled = v; $bNova.disabled = v; }
  async function enviar(texto) {
    texto = (texto || '').trim();
    if (!texto || ocupado) return;
    bloquear(true); $chips.innerHTML = '';
    if (!mensagens.length) $msgs.innerHTML = '';   // sai a tela de boas-vindas ao começar a conversa
    bolha('user', texto);
    const espera = bolha('bot', '');
    espera.classList.add('sp-wait'); espera.innerHTML = '<span class="sp-dots"><i></i><i></i><i></i></span> Consultando os dados...';
    $txt.value = ''; ajustarAltura();
    try {
      const j = await api({ action: 'chat', conversa_id: atualId, mensagem: texto });
      atualId = j.conversa_id; guardarAtiva();
      mensagens.push({ role: 'user', content: texto }, { role: 'assistant', content: j.resposta, anexo: j.relatorio ? { relatorio: j.relatorio } : undefined });
      const s = separarSugestoes(j.resposta);
      espera.classList.remove('sp-wait'); espera.innerHTML = formatar(s.corpo);
      if (j.relatorio) anexarRelatorio(espera, j.relatorio);
      mostrarChips(s.sugestoes);
      if (j.acoes && j.acoes.length) executarAcoes(j.acoes);
    } catch (e) {
      espera.classList.remove('sp-wait'); espera.classList.add('sp-erro');
      espera.innerHTML = `<p>${esc(msgErro(e))}</p>`;
      mostrarChips([texto]);   // a pergunta não foi salva: permite repeti-la com um clique
    } finally {
      bloquear(false); $txt.focus(); $msgs.scrollTop = $msgs.scrollHeight;
    }
  }

  /* ---------- relatórios (PDF / CSV) ---------- */
  let promessaRelatorio = null;
  function carregarGerador() {
    if (window.SAMP_RELATORIO) return Promise.resolve();
    if (!promessaRelatorio) promessaRelatorio = new Promise((ok, falha) => {
      const sc = document.createElement('script'); sc.src = 'relatorio-pdf.js'; sc.onload = ok;
      sc.onerror = () => { promessaRelatorio = null; falha(new Error('Não foi possível carregar o gerador de relatórios.')); }; document.head.appendChild(sc);
    });
    return promessaRelatorio;
  }
  function anexarRelatorio(bolhaEl, spec) {
    const tabelas = spec.secoes.filter((x) => x.tipo === 'tabela').length, graficos = spec.secoes.filter((x) => x.tipo === 'grafico').length;
    const card = el('div', 'sp-anexo',
      `<div class="sp-anexo-t">${esc(spec.titulo)}</div>` +
      `<div class="sp-anexo-s">Relatório com ${spec.secoes.length} seção(ões)${tabelas ? ', ' + tabelas + ' tabela(s)' : ''}${graficos ? ', ' + graficos + ' gráfico(s)' : ''}</div>` +
      '<div class="sp-anexo-b"><button type="button" data-a="pdf">Baixar PDF</button><button type="button" data-a="csv" class="sp-sec">Baixar dados (CSV)</button></div>');
    card._spec = spec;
    bolhaEl.appendChild(card);
    $msgs.scrollTop = $msgs.scrollHeight;
  }
  $msgs.addEventListener('click', async (e) => {
    const b = e.target.closest('.sp-anexo button[data-a]'); if (!b) return;
    const spec = b.closest('.sp-anexo')._spec, rotulo = b.textContent;
    b.disabled = true; b.textContent = 'Gerando...';
    try {
      await carregarGerador();
      if (b.dataset.a === 'pdf') await window.SAMP_RELATORIO.baixarPDF(spec, usuario); else window.SAMP_RELATORIO.baixarCSV(spec);
    } catch (err) { alert(err.message || 'Não foi possível gerar o arquivo.'); }
    b.disabled = false; b.textContent = rotulo;
  });

  /* ---------- ações de interface pedidas pela Sampinha (nunca alteram dados) ---------- */
  const PAGINAS = { inicio: 'index.html', analise: 'analise.html', metricas: 'metricas.html' };
  const NOMES_MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const rotMes = (ym) => NOMES_MES[parseInt(ym.slice(5), 10) - 1] + '/' + ym.slice(0, 4);
  const INPUT_BUSCA = { assuntos: 'searchInput', poloPassivo: 'poloSearchInput', advogadoAtivo: 'advogadoSearchInput' };
  const NOME_ABA = { assuntos: 'Assuntos', poloPassivo: 'Polo Passivo', advogadoAtivo: 'Advogado Polo Ativo', analises: 'Análises' };
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  async function esperar(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) { const r = fn(); if (r) return r; await pausa(150); }
    return null;
  }
  function nota(texto) {
    const n = el('div', 'sp-nota', esc(texto)); $msgs.appendChild(n); $msgs.scrollTop = $msgs.scrollHeight;
  }
  const moduloDa = (a) => (a.acao === 'abrir_modulo' ? a.modulo : a.acao.startsWith('analise') ? 'analise' : a.acao.startsWith('metricas') ? 'metricas' : null);

  async function executarAcao(a) {
    switch (a.acao) {
      case 'abrir_modulo': return 'Você já está neste módulo.';
      case 'analise_aba': {
        const tab = await esperar(() => document.querySelector(`.tab[data-tab="${a.aba}"]`));
        if (!tab) return 'Não encontrei a aba pedida.';
        tab.click(); return `Abri a aba "${NOME_ABA[a.aba]}".`;
      }
      case 'analise_buscar': {
        const tab = await esperar(() => document.querySelector(`.tab[data-tab="${a.aba}"]`));
        if (tab) tab.click();
        const inp = await esperar(() => document.getElementById(INPUT_BUSCA[a.aba]));
        if (!inp) return 'Não consegui acessar o campo de busca (os dados ainda estão carregando?).';
        inp.value = a.texto; inp.dispatchEvent(new Event('input', { bubbles: true }));
        return `Busquei por "${a.texto}" na aba "${NOME_ABA[a.aba]}".`;
      }
      case 'metricas_filtrar': {
        const ini = await esperar(() => { const s = document.getElementById('dataInicialSelect'); return s && s.options.length > 1 ? s : null; });
        if (!ini) return 'Os dados de metas ainda não carregaram; tente novamente.';
        const fim = document.getElementById('dataFinalSelect');
        const acha = (sel, ym) => [...sel.options].find((o) => o.textContent === rotMes(ym));
        const oi = acha(ini, a.mes_inicial), of = acha(fim, a.mes_final);
        if (!oi || !of) return `Um dos meses (${rotMes(a.mes_inicial)} a ${rotMes(a.mes_final)}) está fora do período cadastrado.`;
        ini.value = oi.value; fim.value = of.value; document.getElementById('aplicarFiltroBtn').click();
        return `Filtrei o período de ${rotMes(a.mes_inicial)} a ${rotMes(a.mes_final)}.`;
      }
      case 'metricas_limpar_filtro': {
        const b = await esperar(() => document.getElementById('limparFiltroBtn'));
        if (!b) return 'Não encontrei o botão de limpar filtro.';
        b.click(); return 'Limpei o filtro de período.';
      }
    }
    return null;
  }
  async function executarAcoes(lista) {
    lista = (lista || []).slice(0, 5);
    for (let i = 0; i < lista.length; i++) {
      const a = lista[i], destino = moduloDa(a);
      if (destino && destino !== pagina) {
        // navega e deixa as ações restantes (a atual, se não for só "abrir") para depois do carregamento
        const resto = (a.acao === 'abrir_modulo' ? [] : [a]).concat(lista.slice(i + 1));
        try { sessionStorage.setItem('sampinha_pendentes', JSON.stringify(resto)); sessionStorage.setItem('sampinha_aberta', '1'); } catch (e) {}
        nota('Abrindo ' + ({ analise: 'Análise de Processos', metricas: 'Metas Processuais', inicio: 'a tela inicial' })[destino] + '...');
        await pausa(500); location.href = PAGINAS[destino]; return;
      }
      try { const r = await executarAcao(a); if (r) nota(r); } catch (e) { nota('Não consegui executar uma das ações.'); }
    }
  }

  /* ---------- eventos ---------- */
  function ajustarAltura() { $txt.style.height = 'auto'; $txt.style.overflowY = $txt.scrollHeight > 110 ? 'auto' : 'hidden'; $txt.style.height = Math.min($txt.scrollHeight, 110) + 'px'; }
  $txt.addEventListener('input', ajustarAltura);
  $txt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $form.requestSubmit(); } });
  $form.addEventListener('submit', (e) => { e.preventDefault(); enviar($txt.value); });
  $msgs.addEventListener('click', (e) => {
    const p = e.target.closest('.sp-proc'); if (!p) return;
    navigator.clipboard.writeText(p.dataset.n).then(() => { const o = p.textContent; p.textContent = 'Copiado'; setTimeout(() => (p.textContent = o), 1200); });
  });

  function abrir(v) {
    painel.hidden = !v; botao.hidden = v;
    try { sessionStorage.setItem('sampinha_aberta', v ? '1' : ''); } catch (e) {}
    if (!v) return;
    modoHistorico(false);
    if (atualId && !mensagens.length) carregarConversa(atualId); else if (mensagens.length) desenharMensagens(); else boasVindas();
    $txt.focus();
  }
  botao.onclick = () => abrir(true);
  q('.sp-x').onclick = () => abrir(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !painel.hidden) abrir(false); });

  let aberta = false; try { aberta = !!sessionStorage.getItem('sampinha_aberta'); } catch (e) {}
  if (aberta) abrir(true);

  let pendentes = [];
  try { pendentes = JSON.parse(sessionStorage.getItem('sampinha_pendentes') || '[]'); sessionStorage.removeItem('sampinha_pendentes'); } catch (e) {}
  if (pendentes.length) setTimeout(async () => { await esperar(() => !$msgs.querySelector('.sp-wait'), 6000); executarAcoes(pendentes); }, 600);
})();
