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
      'Quais advogados têm mais processos?',
      'O que você consegue fazer?'
    ],
    inicio: [
      'O que eu consigo fazer no SAMP?',
      'Dê um resumo geral da base de processos',
      'Resuma o desempenho do período mais recente',
      'Quais processos estão atrasados?'
    ],
    producao: [
      'Qual foi a produção do setor no último mês?',
      'Quem mais produziu em 2025?',
      'Compare a produção de 2024 e 2025',
      'Quais os assuntos mais calculados pelo setor?',
      'O que você consegue fazer?'
    ],
    metricas: [
      'Resuma o desempenho do período mais recente',
      'Compare Varas Comuns e JEF',
      'Em que mês o acervo foi maior?',
      'Qual a média de calculados nos últimos 6 meses?',
      'O que você consegue fazer?'
    ]
  };

  // Histórico antigo guardado no navegador (versão anterior): removido, agora fica no servidor.
  try { localStorage.removeItem('sampinha_conv_' + usuario.matricula); } catch (e) {}

  /* ---------- estado ---------- */
  let atualId = null;          // conversa aberta (vive no banco)
  let mensagens = [];          // mensagens da conversa aberta [{role, content}]
  let ocupado = false;
  let iniciado = false;   // conteúdo já montado (minimizar e abrir não redesenha a conversa)
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
  // o que o usuário está vendo agora (ajuda a Sampinha a entender "essa vara", "esse período", "isso"...)
  function contextoTela() {
    const c = {};
    try {
      if (pagina === 'analise') {
        const aba = document.querySelector('.tab.active');
        if (aba) {
          c.aba = aba.textContent.trim();
          const ids = { assuntos: 'searchInput', poloPassivo: 'poloSearchInput', advogadoAtivo: 'advogadoSearchInput' };
          const inp = ids[aba.dataset.tab] && document.getElementById(ids[aba.dataset.tab]);
          if (inp && inp.value.trim()) c.busca = inp.value.trim();
          if (aba.dataset.tab === 'tendencia') {
            const sel = document.querySelector('.tn-heat tr.sel');
            if (sel) c.assunto_selecionado = sel.dataset.assunto;
            const modo = document.querySelector('.tn-seg button.on'); if (modo) c.visao = modo.textContent.trim();
            const rec = document.getElementById('tnEscopo'); if (rec && rec.selectedOptions[0]) c.recorte = rec.selectedOptions[0].textContent.trim();
          }
        }
      } else if (pagina === 'producao') {
        const modo = document.querySelector('.pr-modo button.on');
        if (modo) c.visao_producao = modo.textContent.trim();
        const sp = document.getElementById('selPessoa'), sa = document.getElementById('selAno');
        if (modo && modo.dataset.m === 'pessoa' && sp) c.pessoa = sp.value;
        if (sa && sa.value) c.ano = sa.value;
      } else if (pagina === 'metricas') {
        const i = document.getElementById('dataInicialSelect'), f = document.getElementById('dataFinalSelect');
        if (i && f && i.value !== '' && f.value !== '') c.filtro = i.selectedOptions[0].textContent + ' a ' + f.selectedOptions[0].textContent;
        const per = document.querySelector('#metaPeriodo .chip b');
        if (per) c.periodo = per.textContent.trim();
      }
    } catch (e) {}
    return c;
  }

  // envia a pergunta e acompanha a resposta em fluxo: recebe o andamento ("Buscando processos...") antes do resultado final
  async function chatStream(corpo, aoAndamento) {
    const sessao = window.SAMP_AUTH.get();
    if (!sessao) { window.SAMP_AUTH.irLogin(); throw new Error('Sessão expirada'); }
    const ctl = new AbortController(); const limite = setTimeout(() => ctl.abort(), 150000);   // não espera para sempre
    const r = await fetch(window.APP_CONFIG.SUPABASE_URL + '/functions/v1/sampinha-function', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', apikey: window.APP_CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + window.APP_CONFIG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ token: sessao.token, modulo: pagina, contexto: contextoTela(), stream: true, ...corpo })
    });
    if (!(r.headers.get('content-type') || '').includes('text/event-stream')) {   // erro comum, em JSON
      let j = {}; try { j = await r.json(); } catch (e) {}
      if (r.status === 401) { window.SAMP_AUTH.sair(); throw new Error('Sessão expirada'); }
      if (r.ok && j.resposta) return j;   // compatibilidade com a versão anterior da função
      { const er = new Error(j.error || (r.ok ? 'A Sampinha não devolveu uma resposta. Tente novamente (se persistir, atualize a página com Ctrl+F5).' : 'Erro ' + r.status)); er.detalhe = j.detalhe; throw er; }
    }
    const leitor = r.body.getReader(), dec = new TextDecoder();
    let buf = '', final = null;
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const bloco = buf.slice(0, k); buf = buf.slice(k + 2);
        const linha = bloco.split('\n').find((l) => l.startsWith('data: '));
        if (!linha) continue;
        let ev; try { ev = JSON.parse(linha.slice(6)); } catch (e) { continue; }
        if (ev.t === 'status') aoAndamento(ev.m);
        else if (ev.t === 'fim') final = ev;
        else if (ev.t === 'erro') { const er = new Error(ev.error); er.detalhe = ev.detalhe; throw er; }
      }
    }
    clearTimeout(limite);
    if (!final) throw new Error('A resposta foi interrompida. Tente novamente.');
    return final;
  }
  const msgErro = (e) => (e.name === 'AbortError' ? 'A Sampinha demorou mais do que o esperado. Tente novamente, de preferência com um pedido mais específico.' : e.message === 'Failed to fetch' ? 'Não consegui contatar o servidor. Tente novamente.' : e.message);

  /* ---------- estrutura ---------- */
  const botao = el('button', 'sp-fab', '<span class="sp-av"><img src="img/sampinha-256.png" alt="" width="56" height="83"></span>' +
    '<span class="sp-txt"><b>Sampinha</b><small>Assistente de IA</small></span>');
  botao.type = 'button'; botao.setAttribute('aria-label', 'Abrir a Sampinha, assistente do SAMP');

  const painel = el('section', 'sp-panel');
  painel.setAttribute('role', 'dialog'); painel.setAttribute('aria-label', 'Sampinha - assistente do SAMP'); painel.hidden = true;
  painel.innerHTML =
    '<header class="sp-head"><div class="sp-id"><span class="sp-av sp-av-h"><img src="img/sampinha-cabeca-128.png" alt="" width="44" height="44"></span>' +
    '<div class="sp-titulo"><strong>Sampinha</strong><small>Assistente de IA</small></div></div>' +
    '<div class="sp-actions"><button type="button" class="sp-hbtn sp-bhist" title="Histórico de conversas">Histórico</button>' +
    '<button type="button" class="sp-hbtn sp-bnova" title="Nova conversa">+ Nova</button>' +
    '<button type="button" class="sp-hbtn sp-bamp" title="Ampliar a janela">Ampliar</button>' +
    '<button type="button" class="sp-x" aria-label="Fechar">&times;</button></div></header>' +
    '<div class="sp-barra"><label class="sp-fora"><input type="checkbox" class="sp-fora-ck"> Minimizar ao clicar fora da janela</label></div>' +
    '<div class="sp-hist" hidden>' +
      '<div class="sp-hist-top"><input type="search" class="sp-busca" placeholder="Buscar nas conversas..." aria-label="Buscar nas conversas"><button type="button" class="sp-limpar">Limpar tudo</button></div>' +
      '<div class="sp-hist-lista"></div>' +
    '</div>' +
    '<div class="sp-msgs" aria-live="polite"></div>' +
    '<div class="sp-chips"></div>' +
    '<form class="sp-form"><textarea rows="1" placeholder="Pergunte sobre os processos ou as metas..." maxlength="1500" aria-label="Sua pergunta"></textarea>' +
    '<button type="submit" class="sp-send" aria-label="Enviar">Enviar</button></form>' +
    '<div class="sp-aviso"><span>A Sampinha usa IA e pode errar: confira os dados importantes.</span> <button type="button" class="sp-info" aria-expanded="false">Privacidade</button>' +
      '<div class="sp-aviso-d" hidden>As perguntas e os dados consultados são processados por um serviço externo de IA. O histórico fica salvo no sistema e só você o vê.</div></div>';

  // Estilo crítico injetado pelo próprio script: mesmo que o theme.css esteja em cache antigo, o botão fica
  // fixo no canto da tela (e nunca solto no fim da página).
  if (!document.getElementById('sp-critico')) {
    const st = document.createElement('style');
    st.id = 'sp-critico';
    st.textContent =
      '.sp-fab,.sp-panel{position:fixed!important;margin:0!important;transform:none!important;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;text-align:left;}' +
      '.sp-panel button,.sp-panel input,.sp-panel textarea{font-family:inherit;}' +
      '.sp-fab{color:#12355b!important;}' +
      '.sp-fab{right:max(20px,env(safe-area-inset-right))!important;bottom:max(20px,env(safe-area-inset-bottom))!important;z-index:2147483000!important;}' +
      '.sp-panel{right:max(20px,env(safe-area-inset-right))!important;bottom:max(20px,env(safe-area-inset-bottom))!important;z-index:2147483001!important;}' +
      '.sp-fab[hidden],.sp-panel[hidden]{display:none!important;}' +
      '@media (max-width:520px){.sp-panel{right:6px!important;bottom:6px!important;left:6px!important;width:auto!important;}}' +
      '@media print{.sp-fab,.sp-panel{display:none!important;}}';
    document.head.appendChild(st);
  }
  // montados na raiz do documento (e não no body), fora do alcance de qualquer estilo do corpo da página
  const raiz = document.documentElement;
  raiz.append(botao, painel);
  const q = (s) => painel.querySelector(s);
  const $msgs = q('.sp-msgs'), $chips = q('.sp-chips'), $form = q('.sp-form'), $txt = q('textarea'), $send = q('.sp-send'),
        $hist = q('.sp-hist'), $lista = q('.sp-hist-lista'), $busca = q('.sp-busca'), $aviso = q('.sp-aviso'),
        $bHist = q('.sp-bhist'), $bNova = q('.sp-bnova'), $bAmp = q('.sp-bamp');

  /* ---------- renderização das mensagens ---------- */
  const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
  const primeiroNome = () => { const n = String(usuario.nome || '').trim().split(/\s+/)[0] || ''; return n.charAt(0).toLocaleUpperCase('pt-BR') + n.slice(1).toLocaleLowerCase('pt-BR'); };

  // texto da IA -> HTML seguro (títulos, listas, tabelas, negrito, itálico, código e números de processo clicáveis)
  function formatar(texto) {
    const linhas = esc(texto).split('\n');
    const inline = (t) => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(RX_PROC, (n) => `<button type="button" class="sp-proc" data-n="${n}" title="Copiar número">${n}</button>`);
    const celulas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const ehTabela = (i) => /^\s*\|.*\|\s*$/.test(linhas[i] || '') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(linhas[i + 1] || '');
    let html = '', lista = null;
    const fecha = () => { if (lista) { html += `</${lista}>`; lista = null; } };
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      if (ehTabela(i)) {
        fecha();
        const cab = celulas(l); i += 2;
        const corpo = [];
        while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) { corpo.push(celulas(linhas[i])); i++; }
        i--;
        html += '<div class="sp-tab"><table><thead><tr>' + cab.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          corpo.map((r) => '<tr>' + cab.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
        continue;
      }
      let m;
      if ((m = l.match(/^\s{0,3}#{1,4}\s+(.*)$/))) { fecha(); html += `<h5>${inline(m[1])}</h5>`; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { fecha(); html += '<hr>'; continue; }
      if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { if (lista !== 'ul') { fecha(); html += '<ul>'; lista = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (lista !== 'ol') { fecha(); html += '<ol>'; lista = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
      fecha();
      if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    fecha();
    return html;
  }
  function separarSugestoes(texto) {
    texto = String(texto == null ? '' : texto);
    const m = texto.match(/\n?\s*SUGEST(?:Õ|O)ES:\s*(.+)\s*$/i);
    if (!m) return { corpo: texto, sugestoes: [] };
    return { corpo: texto.slice(0, m.index).trim(), sugestoes: m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 5) };
  }
  function bolha(papel, texto) {
    const b = el('div', 'sp-msg sp-' + papel, papel === 'user' ? `<p>${esc(texto)}</p>` : formatar(texto));
    $msgs.appendChild(b); $msgs.scrollTop = $msgs.scrollHeight; return b;
  }
  function adicionarAcoes(bolhaEl, texto) {
    const b = el('button', 'sp-copiar'); b.type = 'button'; b.textContent = 'Copiar resposta';
    b.onclick = () => navigator.clipboard.writeText(texto).then(() => { b.textContent = 'Copiado'; setTimeout(() => (b.textContent = 'Copiar resposta'), 1400); });
    bolhaEl.appendChild(b);
  }
  function mostrarChips(lista) {
    $chips.innerHTML = '';
    lista.forEach((s) => { const c = el('button', 'sp-chip'); c.type = 'button'; c.textContent = s; c.onclick = () => enviar(s); $chips.appendChild(c); });
  }
  function boasVindas() {
    mensagens = []; $msgs.innerHTML = ''; $chips.innerHTML = '';
    const w = el('div', 'sp-welcome',
      `<div class="sp-w-top"><img class="sp-w-av" src="img/sampinha-256.png" alt="Sampinha" width="84" height="84"><div class="sp-w-t">Olá, ${esc(primeiroNome())}!</div></div>` +
      '<p>Eu sou a Sampinha. Consulto os processos e as metas, gero relatórios em PDF e abro telas e filtros para você. Se eu tiver dúvida sobre o que você quer, pergunto antes de responder.</p>' +
      '<div class="sp-w-l">Experimente perguntar</div><div class="sp-sug"></div>');
    const caixa = w.querySelector('.sp-sug');
    (SUGESTOES[pagina] || SUGESTOES.analise).forEach((txt) => { const b = el('button', 'sp-s'); b.type = 'button'; b.textContent = txt; b.onclick = () => enviar(txt); caixa.appendChild(b); });
    $msgs.appendChild(w);
  }
  function desenharMensagens() {
    $msgs.innerHTML = '';
    let ultimas = [];
    mensagens.forEach((m) => {
      if (m.role === 'user') bolha('user', m.content);
      else { const s = separarSugestoes(m.content); const b = bolha('bot', s.corpo); if (m.anexo && m.anexo.relatorio) anexarRelatorio(b, m.anexo.relatorio); adicionarAcoes(b, s.corpo); ultimas = s.sugestoes; }
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
  const aplicarTamanho = (g) => { painel.classList.toggle('sp-grande', g); $bAmp.textContent = g ? 'Reduzir' : 'Ampliar'; $bAmp.title = g ? 'Voltar ao tamanho normal' : 'Ampliar a janela'; try { localStorage.setItem('sampinha_grande', g ? '1' : ''); } catch (e) {} };
  $bAmp.onclick = () => aplicarTamanho(!painel.classList.contains('sp-grande'));
  try { if (localStorage.getItem('sampinha_grande')) aplicarTamanho(true); } catch (e) {}
  const $info = q('.sp-info'); $info.onclick = () => { const d = q('.sp-aviso-d'); d.hidden = !d.hidden; $info.setAttribute('aria-expanded', String(!d.hidden)); };
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

  /* ---------- animação de espera: o usuário vê que ela está trabalhando ---------- */
  const FRASES_GERAIS = [
    'Lendo os dados do sistema...', 'Conferindo os números para não errar...', 'Cruzando as informações...',
    'Organizando a resposta...', 'Separando o que é relevante do que é ruído...', 'Revisando os totais mais uma vez...',
    'Checando se os números fecham...', 'Colocando tudo em ordem...', 'Procurando o melhor jeito de explicar isso...',
    'Verificando as fontes de dados...', 'Quase lá, só mais um instante...'
  ];
  const FRASES_TEMA = [
    { rx: /relat[oó]rio|pdf|planilha|csv|exporta/i, f: [
      'Montando as seções do relatório...', 'Preenchendo tabelas e gráficos com os dados reais...', 'Revisando o que vai no arquivo...',
      'Escolhendo a melhor forma de apresentar os números...', 'Ajustando títulos, escalas e legendas...', 'Preparando o PDF e a planilha para download...'] },
    { rx: /produ[cç][aã]o|produziu|calculou|ranking|pessoa/i, f: [
      'Somando a produção mês a mês...', 'Agrupando os assuntos calculados...', 'Comparando com os períodos anteriores...',
      'Separando meta, acervo e o que está sem classificação...', 'Procurando o melhor mês e a média do período...', 'Conferindo as prioridades e o tempo até calcular...'] },
    { rx: /tend[eê]ncia|chegada|envelhec|reten[cç][aã]o|acervo velho/i, f: [
      'Calculando a idade dos processos por assunto...', 'Comparando cada assunto com o conjunto...', 'Procurando onde o acervo está envelhecendo...',
      'Medindo a chegada de processos nos últimos 30 dias...', 'Estimando a data de entrada de cada processo...', 'Identificando os assuntos que pedem atenção...'] },
    { rx: /meta|recebid|calculad|acervo|jef|varas?/i, f: [
      'Consultando as metas processuais...', 'Calculando médias e variações...', 'Comparando Varas Comuns e JEF...',
      'Acompanhando a evolução do acervo mês a mês...', 'Conferindo recebidos, calculados e tempo de permanência...'] },
    { rx: /processo|atrasad|assunto|advogado|prazo/i, f: [
      'Varrendo a base de processos...', 'Aplicando os prazos configurados...', 'Agrupando os resultados...',
      'Classificando os processos por situação de prazo...', 'Procurando o que combina com o seu pedido...', 'Ordenando do mais antigo para o mais novo...'] }
  ];
  const DICAS = [
    'Dica: peça "gere um relatório" para receber a resposta em PDF ou CSV.',
    'Dica: você pode minimizar a conversa; aviso aqui quando terminar.',
    'Dica: cite o período ou a pessoa para uma resposta mais precisa.',
    'Dica: use o histórico (relógio no topo) para retomar conversas anteriores.',
    'Lembrete: confira sempre os números importantes na fonte original.',
    'Dica: perguntas específicas costumam ser respondidas mais rápido.'
  ];
  function iniciarEspera(bolhaEl, pergunta) {
    const tema = FRASES_TEMA.filter((t) => t.rx.test(pergunta)).flatMap((t) => t.f);
    const mistura = (v) => v.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const fila = [...mistura(tema), ...mistura(FRASES_GERAIS)], t0 = Date.now(); let i = 0;
    bolhaEl.classList.add('sp-wait');
    bolhaEl.innerHTML =
      '<div class="sp-wt">' +
      '<div class="sp-wb"><div class="sp-line"><span class="sp-dots"><i></i><i></i><i></i></span><span class="sp-st">Entendendo o seu pedido...</span></div>' +
      '<div class="sp-frase" aria-hidden="true"></div><div class="sp-bar" aria-hidden="true"><i></i></div></div></div>';
    const fr = bolhaEl.querySelector('.sp-frase');
    const trocar = () => {
      const seg = (Date.now() - t0) / 1000;
      let txt;
      if (seg > 75) txt = 'Está demorando mais que o normal. Pode continuar usando o SAMP: eu aviso aqui quando terminar.';
      else if (seg > 35) txt = 'Consultas com muitos dados levam um pouco mais. Continuo trabalhando nisso...';
      else if (seg > 14 && i % 4 === 3) txt = DICAS[Math.floor(i / 4) % DICAS.length];
      else txt = fila[i % fila.length];
      i++;
      fr.classList.remove('on'); void fr.offsetWidth;   // reinicia a animação de entrada
      fr.textContent = txt; fr.classList.add('on');
    };
    const primeira = setTimeout(trocar, 1800);
    const ciclo = setInterval(trocar, 3600);
    return () => { clearTimeout(primeira); clearInterval(ciclo); };
  }

  /* ---------- envio ---------- */
  function bloquear(v) { ocupado = v; botao.classList.toggle('sp-ocupado', v && painel.hidden); $send.disabled = v; $txt.disabled = v; $bHist.disabled = v; $bNova.disabled = v; }
  async function enviar(texto) {
    texto = (texto || '').trim();
    if (!texto || ocupado) return;
    bloquear(true); $chips.innerHTML = ''; let ancorar = false;
    if (!mensagens.length) $msgs.innerHTML = '';   // sai a tela de boas-vindas ao começar a conversa
    bolha('user', texto);
    const espera = bolha('bot', '');
    const pararEspera = iniciarEspera(espera, texto);
    $txt.value = ''; ajustarAltura();
    try {
      const j = await chatStream({ action: 'chat', conversa_id: atualId, mensagem: texto }, (m) => { const st = espera.querySelector('.sp-st'); if (st) st.textContent = m; });
      if (!j || !j.resposta) throw new Error('A Sampinha não devolveu uma resposta. Tente novamente.');
      atualId = j.conversa_id; guardarAtiva();
      mensagens.push({ role: 'user', content: texto }, { role: 'assistant', content: j.resposta, anexo: j.relatorio ? { relatorio: j.relatorio } : undefined });
      const s = separarSugestoes(j.resposta);
      pararEspera(); espera.classList.remove('sp-wait'); espera.innerHTML = formatar(s.corpo);
      if (j.relatorio) anexarRelatorio(espera, j.relatorio);
      adicionarAcoes(espera, s.corpo);
      mostrarChips(s.sugestoes);
      if (espera.offsetHeight > $msgs.clientHeight * 0.6) { ancorar = true; $msgs.scrollTop = Math.max(0, espera.getBoundingClientRect().top - $msgs.getBoundingClientRect().top + $msgs.scrollTop - 10); }   // resposta longa: mostra o começo
      if (j.acoes && j.acoes.length) executarAcoes(j.acoes);
    } catch (e) {
      pararEspera(); espera.classList.remove('sp-wait'); espera.classList.add('sp-erro');
      espera.innerHTML = `<p>${esc(msgErro(e))}</p>` + (e.detalhe ? `<p class="sp-det">Detalhe técnico: ${esc(e.detalhe)}</p>` : '');
      mostrarChips([texto]);   // a pergunta não foi salva: permite repeti-la com um clique
    } finally {
      pararEspera(); bloquear(false); if (painel.hidden) botao.classList.add('sp-novo'); else $txt.focus();
      if (!ancorar) $msgs.scrollTop = $msgs.scrollHeight;
    }
  }

  /* ---------- relatórios (PDF / CSV) ---------- */
  let promessaRelatorio = null;
  function carregarGerador() {
    if (window.SAMP_RELATORIO) return Promise.resolve();
    if (!promessaRelatorio) promessaRelatorio = new Promise((ok, falha) => {
      const sc = document.createElement('script'); sc.src = 'relatorio-pdf.js?v=20261001a'; sc.onload = ok;
      sc.onerror = () => { promessaRelatorio = null; falha(new Error('Não foi possível carregar o gerador de relatórios.')); }; document.head.appendChild(sc);
    });
    return promessaRelatorio;
  }
  function anexarRelatorio(bolhaEl, spec) {
    const tabelas = spec.secoes.filter((x) => x.tipo === 'tabela').length, graficos = spec.secoes.filter((x) => x.tipo === 'grafico').length;
    const ROT = { texto: 'Texto', kpis: 'Indicadores', tabela: 'Tabela', grafico: 'Gráfico' };
    const itens = spec.secoes.slice(0, 8).map((x) => `<li>${ROT[x.tipo] || x.tipo}${x.titulo ? ': ' + esc(x.titulo) : ''}</li>`).join('');
    const card = el('div', 'sp-anexo',
      `<div class="sp-anexo-t">${esc(spec.titulo)}</div>` +
      (spec.interpretacao ? `<div class="sp-anexo-i"><b>Entendi:</b> ${esc(spec.interpretacao)}</div>` : '') +
      `<div class="sp-anexo-s">Relatório com ${spec.secoes.length} seção(ões)${tabelas ? ', ' + tabelas + ' tabela(s)' : ''}${graficos ? ', ' + graficos + ' gráfico(s)' : ''}</div>` +
      `<ul class="sp-anexo-l">${itens}</ul>` +
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
  const PAGINAS = { inicio: 'index.html', analise: 'analise.html', metricas: 'metricas.html', producao: 'producao.html' };
  const NOMES_MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const rotMes = (ym) => NOMES_MES[parseInt(ym.slice(5), 10) - 1] + '/' + ym.slice(0, 4);
  const INPUT_BUSCA = { assuntos: 'searchInput', poloPassivo: 'poloSearchInput', advogadoAtivo: 'advogadoSearchInput' };
  const NOME_ABA = { assuntos: 'Assuntos', poloPassivo: 'Polo Passivo', advogadoAtivo: 'Advogado Polo Ativo', analises: 'Análises', tendencia: 'Tendência' };
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  async function esperar(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) { const r = fn(); if (r) return r; await pausa(150); }
    return null;
  }
  function nota(texto) {
    const n = el('div', 'sp-nota', esc(texto)); $msgs.appendChild(n); $msgs.scrollTop = $msgs.scrollHeight;
  }
  const moduloDa = (a) => (a.acao === 'abrir_modulo' ? a.modulo : (a.acao.startsWith('analise') || a.acao.startsWith('tendencia')) ? 'analise' : a.acao.startsWith('metricas') ? 'metricas' : a.acao.startsWith('producao') ? 'producao' : null);

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
      case 'tendencia_assunto': {
        const tab = await esperar(() => document.querySelector('.tab[data-tab="tendencia"]'));
        if (!tab) return 'Não encontrei a aba Tendência.';
        if (!tab.classList.contains('active')) tab.click();
        const linhas = await esperar(() => { const l = [...document.querySelectorAll('.tn-heat tr[data-assunto]')]; return l.length ? l : null; });
        if (!linhas) return 'O painel de Tendência ainda não carregou; tente novamente.';
        const norm = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const alvo = norm(a.texto);
        const tr = linhas.find((l) => norm(l.dataset.assunto) === alvo) || linhas.find((l) => norm(l.dataset.assunto).includes(alvo));
        if (!tr) return `O assunto "${a.texto}" não aparece entre os assuntos exibidos na Tendência (use "Mostrar todos").`;
        tr.click(); return `Selecionei o assunto "${tr.dataset.assunto}" na aba Tendência.`;
      }
      case 'tendencia_modo': {
        const tab = await esperar(() => document.querySelector('.tab[data-tab="tendencia"]'));
        if (tab && !tab.classList.contains('active')) tab.click();
        const b = await esperar(() => document.querySelector(`.tn-seg button[data-modo="${a.modo}"]`));
        if (!b) return 'Não encontrei o seletor do mapa de calor.';
        b.click(); return a.modo === 'mes' ? 'Mapa de calor por mês de chegada.' : 'Mapa de calor por faixa de idade.';
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
      case 'producao_filtrar': {
        const sel = await esperar(() => document.getElementById('selPessoa'));
        if (!sel) return 'A produção ainda não carregou; tente novamente.';
        const norm = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        const alvo = norm(a.pessoa || ''), setor = !alvo || /^(setor|todos|todas|geral|equipe)$/.test(alvo);
        const botoes = [...document.querySelectorAll('.pr-modo button')];
        let msgPessoa = 'Visão do setor';
        if (setor) botoes.find((b) => b.dataset.m === 'setor').click();
        else {
          const op = [...sel.options].find((o) => norm(o.textContent) === alvo) || [...sel.options].find((o) => norm(o.textContent).includes(alvo));
          if (!op) return `Esta matrícula não tem acesso à produção individual de "${a.pessoa}" (ou o nome não existe). O Setor continua disponível.`;
          sel.value = op.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
          botoes.find((b) => b.dataset.m === 'pessoa').click(); msgPessoa = 'Produção de ' + op.textContent;
        }
        const sa = document.getElementById('selAno');
        if (sa) { sa.value = a.ano ? String(a.ano) : ''; sa.dispatchEvent(new Event('change', { bubbles: true })); }
        return msgPessoa + (a.ano ? ', ano ' + a.ano : ', todos os anos') + '.';
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
        nota('Abrindo ' + ({ analise: 'Análise de Processos', metricas: 'Metas Processuais', producao: 'Produção Individual', inicio: 'a tela inicial' })[destino] + '...');
        await pausa(500); location.href = PAGINAS[destino]; return;
      }
      try { const r = await executarAcao(a); if (r) nota(r); } catch (e) { nota('Não consegui executar uma das ações.'); }
    }
  }

  /* ---------- eventos ---------- */
  function ajustarAltura() { $txt.style.height = 'auto'; $txt.style.overflowY = $txt.scrollHeight > 110 ? 'auto' : 'hidden'; $txt.style.height = Math.min($txt.scrollHeight, 110) + 'px'; }
  $txt.addEventListener('input', ajustarAltura);
  $txt.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' || $txt.value.trim()) return;
    const ultima = [...mensagens].reverse().find((m) => m.role === 'user');
    if (ultima) { e.preventDefault(); $txt.value = ultima.content; ajustarAltura(); }
  });
  $txt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $form.requestSubmit(); } });
  $form.addEventListener('submit', (e) => { e.preventDefault(); enviar($txt.value); });
  $msgs.addEventListener('click', (e) => {
    const p = e.target.closest('.sp-proc'); if (!p) return;
    navigator.clipboard.writeText(p.dataset.n).then(() => { const o = p.textContent; p.textContent = 'Copiado'; setTimeout(() => (p.textContent = o), 1200); });
  });

  function ajustarJanela() {
    const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
    painel.style.maxHeight = Math.max(320, h - 24) + 'px';
  }
  ajustarJanela();
  window.addEventListener('resize', ajustarJanela);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', ajustarJanela);

  function abrir(v) {
    painel.hidden = !v; botao.hidden = v;
    try { sessionStorage.setItem('sampinha_aberta', v ? '1' : ''); } catch (e) {}
    if (!v) { botao.classList.toggle('sp-ocupado', ocupado); return; }   // minimizada: avisa no botão se ainda está respondendo
    botao.classList.remove('sp-ocupado', 'sp-novo');
    if (!iniciado) {   // primeira abertura nesta página: monta a conversa. Depois, a janela continua exatamente como estava.
      iniciado = true;
      modoHistorico(false);
      if (atualId && !mensagens.length) carregarConversa(atualId); else if (mensagens.length) desenharMensagens(); else boasVindas();
    }
    $txt.focus();
  }
  botao.onclick = () => abrir(true);
  q('.sp-x').onclick = () => abrir(false);
  // Clicar na barra azul (em qualquer ponto que não seja um dos botões) minimiza a janela.
  const $cab = q('.sp-head'); $cab.title = 'Clique na barra para minimizar';
  $cab.addEventListener('click', (e) => { if (e.target.closest('button, a, input, label')) return; abrir(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !painel.hidden) abrir(false); });

  // Minimizar ao clicar fora: opção no topo da janela (ligada por padrão; a escolha fica guardada).
  // Usa 'pointerdown' (clique real do mouse/toque): os cliques automáticos que a própria Sampinha faz na tela (element.click()) não disparam esse evento.
  const $fora = q('.sp-fora-ck');
  let minimizarFora = true;
  try { minimizarFora = localStorage.getItem('sampinha_fora') !== '0'; } catch (e) {}
  $fora.checked = minimizarFora;
  $fora.onchange = () => { minimizarFora = $fora.checked; try { localStorage.setItem('sampinha_fora', minimizarFora ? '1' : '0'); } catch (e) {} };
  document.addEventListener('pointerdown', (e) => {
    if (!minimizarFora || painel.hidden) return;
    const alvo = e.target;
    if (!alvo || painel.contains(alvo) || botao.contains(alvo)) return;
    if (alvo.closest && alvo.closest('dialog, .toastx')) return;                                   // janelas modais da página (ex.: glossário) não contam como "fora"
    if (e.clientX >= document.documentElement.clientWidth || e.clientY >= document.documentElement.clientHeight) return;   // barras de rolagem da página
    abrir(false);
  }, true);

  document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); abrir(painel.hidden); } });   // Alt+S abre/fecha

  // vigilância: garante que a Sampinha continue no canto da tela, disponível para abrir ou fechar
  setInterval(() => {
    if (!botao.isConnected || !painel.isConnected) raiz.append(botao, painel);
    if (painel.hidden && botao.hidden) botao.hidden = false;   // nunca ficam os dois ocultos
    if (!painel.hidden && !botao.hidden) botao.hidden = true;
  }, 1500);

  let aberta = false; try { aberta = !!sessionStorage.getItem('sampinha_aberta'); } catch (e) {}
  if (aberta) abrir(true);

  let pendentes = [];
  try { pendentes = JSON.parse(sessionStorage.getItem('sampinha_pendentes') || '[]'); sessionStorage.removeItem('sampinha_pendentes'); } catch (e) {}
  if (pendentes.length) setTimeout(async () => { await esperar(() => !$msgs.querySelector('.sp-wait'), 6000); executarAcoes(pendentes); }, 600);
})();
