// Aba "Tendência" da Análise de Processos: perfil de chegada e envelhecimento por assunto.
//
// Método: a data de entrada de cada processo é estimada por (data da importação - dias na tarefa). Só enxergamos quem
// AINDA está na fila; por isso o painel mostra onde o acervo está VELHO (envelhecendo) e onde há CHEGADA ALTA (onda recente),
// e não "entradas x saídas". O histórico real de acervo/entradas/saídas vem das fotos gravadas a cada importação.
(function () {
  const MIN_AMOSTRA = 10;
  // Selo "Chegada em volume": o assunto concentra uma fatia dos processos NOVOS (últimos 30 dias) bem maior que a fatia do acervo que ele tem.
  const VOL_RAZAO = 1.3, VOL_MIN_NOVOS = 10, VOL_MIN_FATIA = 0.05;
  // Assuntos que não entram na aba Tendência (nem nos indicadores do conjunto). Comparação sem acento e sem diferenciar maiúsculas.
  const ASSUNTOS_OCULTOS = ['registro nulo'];
  const semAcento = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const oculto = (assunto) => ASSUNTOS_OCULTOS.includes(semAcento(assunto));
  const MESES_COLUNAS = 12;
  const NOMES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const FAIXAS = [
    { id: 'f0_30', rot: '0-30', de: 0, ate: 30, cor: '#2f7d5b' }, { id: 'f31_60', rot: '31-60', de: 31, ate: 60, cor: '#86bd9f' },
    { id: 'f61_90', rot: '61-90', de: 61, ate: 90, cor: '#e6cc7e' }, { id: 'f91_120', rot: '91-120', de: 91, ate: 120, cor: '#dcaa4a' },
    { id: 'f121_180', rot: '121-180', de: 121, ate: 180, cor: '#cc7a30' }, { id: 'f181_365', rot: '181-365', de: 181, ate: 365, cor: '#b3261e' },
    { id: 'f366_mais', rot: '366 ou mais', de: 366, ate: Infinity, cor: '#7a1511' }
  ];
  const CORES = { ambos: '#b3261e', parado: '#b7791f', chegada: '#2b6cb0', normal: '#2f7d5b', poucos: '#9fb0c3' };
  const estado = { modo: 'mes', escopo: 'todos', ordem: 'atencao', pct: false, todos: false, assunto: null, avancado: false };
  let charts = [], fotosCache = null, ctxAtual = null, raiz = null;

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n0 = (x) => Number(x).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const pc = (x) => (x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + '%';
  const chaveMes = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const rotMes = (k) => NOMES[parseInt(k.slice(5), 10) - 1] + '/' + k.slice(2, 4);
  const faixaDe = (d) => FAIXAS.find((f) => d >= f.de && d <= f.ate);
  const numVara = (nome) => { const m = String(nome || '').match(/(\d{1,2})/); return m ? parseInt(m[1], 10) : null; };
  const quantil = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.ceil(q * arr.length) - 1))] : 0);

  /* ---------- cálculo ---------- */
  function calcular(ctx) {
    const ref = new Date(ctx.ref); const refOk = isFinite(ref) ? ref : new Date();
    const fim = new Date(refOk.getFullYear(), refOk.getMonth(), 1);
    const meses = [];
    for (let i = MESES_COLUNAS - 1; i >= 0; i--) meses.push(chaveMes(new Date(fim.getFullYear(), fim.getMonth() - i, 1)));
    const setMeses = new Set(meses);
    const lista = ctx.proc.filter((p) => {
      if (oculto(p.assuntoPrincipal)) return false;
      if (estado.escopo === 'todos') return true;
      const v = numVara(p.orgaoJulgador);
      if (v == null) return false;
      return estado.escopo === 'jef' ? v >= 23 : v <= 22;
    });
    const novo = () => ({ n: 0, dias: [], porMes: {}, anteriores: 0, faixas: {} });
    const geral = novo(); const mapa = new Map();
    for (const p of lista) {
      const d = Math.max(0, Number(p.diasChegada) || 0);
      const mk = chaveMes(new Date(refOk.getTime() - d * 86400000));
      const alvo = [geral, mapa.get(p.assuntoPrincipal) || (mapa.set(p.assuntoPrincipal, novo()), mapa.get(p.assuntoPrincipal))];
      for (const a of alvo) {
        a.n++; a.dias.push(d);
        if (setMeses.has(mk)) a.porMes[mk] = (a.porMes[mk] || 0) + 1; else a.anteriores++;
        const f = faixaDe(d).id; a.faixas[f] = (a.faixas[f] || 0) + 1;
      }
    }
    const fecha = (a) => {
      a.dias.sort((x, y) => x - y);
      a.mediana = quantil(a.dias, 0.5); a.p90 = quantil(a.dias, 0.9);
      a.pAcima = a.n ? a.dias.filter((d) => d > ctx.prazo).length / a.n : 0;
      a.nRecentes = a.dias.filter((d) => d <= 30).length;
      a.pRecente = a.n ? a.nRecentes / a.n : 0;
      return a;
    };
    fecha(geral);
    const itens = [...mapa.entries()].map(([assunto, a]) => { fecha(a); a.assunto = assunto; return a; });
    for (const a of itens) {
      a.pequena = a.n < MIN_AMOSTRA;
      a.pressao = !a.pequena && a.pRecente >= geral.pRecente * 1.5 && a.pRecente - geral.pRecente >= 0.10;
      a.retencao = !a.pequena && ((a.pAcima >= geral.pAcima * 1.5 && a.pAcima - geral.pAcima >= 0.10) || (a.mediana >= geral.mediana * 1.5 && a.mediana - geral.mediana >= 30));
      a.grupo = a.pequena ? 'poucos' : a.pressao && a.retencao ? 'ambos' : a.retencao ? 'parado' : a.pressao ? 'chegada' : 'normal';
      a.status = { poucos: 'Poucos processos', ambos: 'Acervo velho e chegada alta', parado: 'Acervo velho', chegada: 'Chegada alta', normal: 'Normal' }[a.grupo];
      a.gravidade = (a.pressao ? 1 : 0) + (a.retencao ? 1 : 0);
      a.fatiaNovos = geral.nRecentes ? a.nRecentes / geral.nRecentes : 0;
      a.fatiaAcervo = geral.n ? a.n / geral.n : 0;
      a.concentracao = a.fatiaAcervo ? a.fatiaNovos / a.fatiaAcervo : 0;
      a.volume = !a.pequena && a.nRecentes >= VOL_MIN_NOVOS && a.fatiaNovos >= VOL_MIN_FATIA && a.concentracao >= VOL_RAZAO;
    }
    return { ref: refOk, meses, geral, itens };
  }

  function ordenar(itens) {
    const peq = (a, b) => Number(a.pequena) - Number(b.pequena);
    const f = {
      atencao: (a, b) => peq(a, b) || (b.gravidade - a.gravidade) || (Number(b.volume) - Number(a.volume)) || (b.n - a.n),
      acervo: (a, b) => b.n - a.n,
      idade: (a, b) => peq(a, b) || (b.mediana - a.mediana)
    };
    return [...itens].sort(f[estado.ordem] || f.atencao);
  }

  /* ---------- peças visuais ---------- */
  function barraIdade(a) {
    return '<div class="tn2-bar">' + FAIXAS.map((f) => {
      const v = a.faixas[f.id] || 0; if (!v) return '';
      return `<i style="width:${(v / a.n) * 100}%;background:${f.cor}" title="${f.rot} dias: ${n0(v)} processo(s) (${pc(v / a.n)})"></i>`;
    }).join('') + '</div>';
  }
  const legendaIdade = () => '<div class="tn2-leg"><span>Idade dos processos:</span>' + FAIXAS.map((f) => `<em><i style="background:${f.cor}"></i>${f.rot} dias</em>`).join('') + '</div>';
  const chipVolume = '<span class="tn2-chip g-volume" title="Concentra mais processos novos do que o tamanho do seu acervo">Chegada em volume</span>';
  const chip = (a) => (a.grupo === 'normal' && a.volume ? chipVolume : `<span class="tn2-chip g-${a.grupo}">${esc(a.status)}</span>` + (a.volume ? ' ' + chipVolume : ''));

  function frase(a, g, prazo) {
    const leitura = {
      ambos: 'O acervo deste assunto está envelhecendo e, ao mesmo tempo, chega muito processo novo: é o caso que mais merece atenção.',
      parado: 'O acervo deste assunto está envelhecendo mais do que o padrão: há processos esperando há mais tempo que o normal.',
      chegada: 'Está chegando mais processo novo do que o padrão. Vale acompanhar para não virar acúmulo.',
      normal: 'Dentro do padrão do conjunto.',
      poucos: `Poucos processos (menos de ${MIN_AMOSTRA}): leia os percentuais com cautela.`
    }[a.grupo];
    const vol = a.volume ? ` <b>Chegada em volume:</b> concentra <b>${pc(a.fatiaNovos)}</b> dos processos novos do conjunto, mas tem <b>${pc(a.fatiaAcervo)}</b> do acervo (${a.concentracao.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} vez o esperado pelo tamanho).` : '';
    const leit = a.grupo === 'normal' && a.volume ? 'Sem acervo velho, porém está recebendo bem mais processos novos do que o tamanho do seu acervo.' : leitura;
    return `<b>${n0(a.n)} processos</b> neste assunto. <b>${pc(a.pAcima)}</b> passam de ${prazo} dias (no conjunto: ${pc(g.pAcima)}) e a idade mediana é <b>${n0(a.mediana)} dias</b> (no conjunto: ${n0(g.mediana)}). ` +
      `<b>${pc(a.pRecente)}</b> chegaram nos últimos 30 dias (no conjunto: ${pc(g.pRecente)}).<br><span class="tn2-leitura">${leit}${vol}</span>`;
  }

  function resumo(dados, prazo) {
    const g = dados.geral;
    const parados = dados.itens.filter((a) => a.retencao), chegando = dados.itens.filter((a) => a.pressao), volumes = dados.itens.filter((a) => a.volume);
    const nomes = (l) => { const o = [...l].sort((x, y) => y.n - x.n); return o.slice(0, 3).map((a) => `<b>${esc(a.assunto)}</b>`).join(', ') + (o.length > 3 ? ` e mais ${o.length - 3}` : ''); };
    const intro = `<p>Dos <b>${n0(g.n)} processos</b>, <b>${pc(g.pAcima)}</b> estão há mais de ${prazo} dias na tarefa e a idade mediana é de <b>${n0(g.mediana)} dias</b>.`;
    if (!parados.length && !chegando.length && !volumes.length) return intro + ' Nenhum assunto foge do padrão do conjunto neste momento.</p>';
    const li = (grupo, rotulo, desc, l) => (l.length ? `<li><span class="tn2-chip g-${grupo}">${rotulo}</span><span><b>${l.length}</b> assunto(s) ${desc}: ${nomes(l)}</span></li>` : '');
    return intro + '</p><ul class="tn2-resumo-l">' +
      li('parado', 'Acervo velho', 'com processos esperando há mais tempo que o normal', parados) +
      li('chegada', 'Chegada alta', 'recebendo muito processo novo', chegando) +
      li('volume', 'Chegada em volume', 'recebendo mais do que o tamanho do acervo', volumes) + '</ul>';
  }

  function cartaoAtencao(a, g, prazo) {
    const linhas = [];
    if (a.retencao) linhas.push(`<b>${pc(a.pAcima)}</b> passam de ${prazo} dias <small>(conjunto: ${pc(g.pAcima)})</small> · mediana <b>${n0(a.mediana)} d</b> <small>(conjunto: ${n0(g.mediana)} d)</small>`);
    if (a.pressao) linhas.push(`<b>${pc(a.pRecente)}</b> chegaram nos últimos 30 dias <small>(conjunto: ${pc(g.pRecente)})</small>`);
    if (a.volume) linhas.push(`concentra <b>${pc(a.fatiaNovos)}</b> dos processos novos do conjunto e tem <b>${pc(a.fatiaAcervo)}</b> do acervo <small>(${a.concentracao.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} vez o esperado · ${n0(a.nRecentes)} novos)</small>`);
    return `<button type="button" class="tn2-card g-${a.grupo === 'normal' && a.volume ? 'volume' : a.grupo}${a.assunto === estado.assunto ? ' sel' : ''}" data-assunto="${esc(a.assunto)}">
      <span class="tn2-chips">${chip(a)}</span><strong>${esc(a.assunto)}</strong><span class="tn2-n">${n0(a.n)} processos</span>
      <p>${linhas.join('<br>')}</p>${barraIdade(a)}</button>`;
  }

  function listaAssuntos(visiveis, g) {
    return '<div class="tn2-lista">' + visiveis.map((a) =>
      `<button type="button" class="tn2-li${a.assunto === estado.assunto ? ' sel' : ''}" data-assunto="${esc(a.assunto)}" title="${esc(a.assunto)}">
        <span class="tn2-nome">${esc(a.assunto)}</span><span class="tn2-qtd">${n0(a.n)}</span>${barraIdade(a)}
        <span class="tn2-med" title="Metade dos processos tem mais que isso de idade">${n0(a.mediana)} d</span><span class="tn2-chips">${chip(a)}</span></button>`).join('') + '</div>';
  }

  /* ---------- mapa de calor e tabela (detalhes recolhidos) ---------- */
  function valoresLinha(a, dados) {
    if (estado.modo === 'mes') return [...dados.meses.map((m) => a.porMes[m] || 0), a.anteriores];
    return FAIXAS.map((f) => a.faixas[f.id] || 0);
  }
  const cabecalho = (dados) => (estado.modo === 'mes' ? [...dados.meses.map(rotMes), 'Anteriores'] : FAIXAS.map((f) => f.rot + ' d'));
  function mapaCalor(dados, visiveis) {
    const cols = cabecalho(dados);
    const linhas = visiveis.map((a) => ({ a, v: valoresLinha(a, dados) }));
    let max = 0;
    for (const l of linhas) for (const x of l.v) { const val = estado.pct ? (l.a.n ? x / l.a.n : 0) : x; if (val > max) max = val; }
    const tot = valoresLinha(dados.geral, dados);
    let h = '<div class="tn-scroll"><table class="tn-heat"><thead><tr><th class="tn-a">Assunto</th><th>Total</th>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (const { a, v } of linhas) {
      h += `<tr data-assunto="${esc(a.assunto)}" class="${a.assunto === estado.assunto ? 'sel' : ''}"><td class="tn-a" title="${esc(a.assunto)}">${esc(a.assunto)}</td><td class="tn-t">${n0(a.n)}</td>`;
      for (const x of v) {
        const val = estado.pct ? (a.n ? x / a.n : 0) : x;
        const t = max ? Math.sqrt(val / max) : 0;
        const bg = x ? `rgba(18,53,91,${(0.08 + t * 0.85).toFixed(2)})` : 'transparent';
        h += `<td class="tn-c" style="background:${bg};color:${t > 0.55 ? '#fff' : 'var(--ink)'}" title="${esc(a.assunto)}: ${n0(x)} processo(s)">${x ? (estado.pct ? pc(a.n ? x / a.n : 0) : n0(x)) : ''}</td>`;
      }
      h += '</tr>';
    }
    h += `<tr class="tn-geral"><td class="tn-a">Todos os assuntos</td><td class="tn-t">${n0(dados.geral.n)}</td>` +
      tot.map((x) => `<td class="tn-c">${estado.pct ? pc(dados.geral.n ? x / dados.geral.n : 0) : n0(x)}</td>`).join('') + '</tr></tbody></table></div>';
    return h;
  }
  function tabelaComparacao(dados, visiveis, prazo) {
    const g = dados.geral;
    const dif = (x, ref, fmt) => { const d = x - ref; return d === 0 ? '' : `<small class="${d > 0 ? 'mais' : 'menos'}">${d > 0 ? '+' : ''}${fmt(d)}</small>`; };
    let h = '<div class="tn-scroll"><table class="tn-cmp"><thead><tr><th class="tn-a">Assunto</th><th>Processos</th><th>Idade mediana</th><th>Percentil 90</th>' +
      `<th>Acima de ${prazo} dias</th><th>Chegaram em 30 dias</th><th>Situação</th></tr></thead><tbody>`;
    for (const a of visiveis) {
      h += `<tr data-assunto="${esc(a.assunto)}" class="${a.assunto === estado.assunto ? 'sel' : ''}"><td class="tn-a" title="${esc(a.assunto)}">${esc(a.assunto)}</td><td>${n0(a.n)}</td>` +
        `<td>${n0(a.mediana)} d ${dif(a.mediana, g.mediana, n0)}</td><td>${n0(a.p90)} d</td>` +
        `<td>${pc(a.pAcima)} ${dif(a.pAcima * 100, g.pAcima * 100, (x) => n0(x) + ' p.p.')}</td><td>${pc(a.pRecente)} ${dif(a.pRecente * 100, g.pRecente * 100, (x) => n0(x) + ' p.p.')}</td><td>${chip(a)}</td></tr>`;
    }
    h += `<tr class="tn-geral"><td class="tn-a">Todos os assuntos</td><td>${n0(g.n)}</td><td>${n0(g.mediana)} d</td><td>${n0(g.p90)} d</td><td>${pc(g.pAcima)}</td><td>${pc(g.pRecente)}</td><td></td></tr></tbody></table></div>`;
    return h;
  }

  /* ---------- gráficos ---------- */
  function limparGraficos() { charts.forEach((c) => { try { c.destroy(); } catch (e) {} }); charts = []; }

  function graficoSituacao(dados) {
    if (!window.Chart) return;
    const g = dados.geral, maxN = Math.max(...dados.itens.map((a) => a.n), 1);
    const pontos = dados.itens.map((a) => ({ x: Math.round(a.pRecente * 1000) / 10, y: Math.round(a.pAcima * 1000) / 10, r: 4 + Math.sqrt(a.n / maxN) * 15, assunto: a.assunto, n: a.n, status: a.status, grupo: a.grupo }));
    const fundo = {   // linhas do conjunto e nomes dos quadrantes ficam ATRÁS das bolhas
      id: 'tnFundo',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;
        const gx = x.getPixelForValue(g.pRecente * 100), gy = y.getPixelForValue(g.pAcima * 100);
        ctx.save();
        ctx.setLineDash([5, 4]); ctx.strokeStyle = '#9fb0c3'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(gx, top); ctx.lineTo(gx, bottom); ctx.moveTo(left, gy); ctx.lineTo(right, gy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(95,107,122,.34)'; ctx.font = '700 12px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('ACERVO VELHO', (left + gx) / 2, (top + gy) / 2); ctx.fillText('VELHO E CHEGADA ALTA', (gx + right) / 2, (top + gy) / 2);
        ctx.fillText('NORMAL', (left + gx) / 2, (gy + bottom) / 2); ctx.fillText('CHEGADA ALTA', (gx + right) / 2, (gy + bottom) / 2);
        ctx.restore();
      }
    };
    const marcas = (passo) => ({ afterBuildTicks(scale) { const t = []; for (let v = 0; v <= 100; v += passo) t.push({ value: v }); scale.ticks = t; } });
    const c = new window.Chart(document.getElementById('tnSit'), {
      type: 'bubble',
      data: { datasets: [{ clip: false, data: pontos, backgroundColor: pontos.map((p) => CORES[p.grupo] + 'cc'), borderColor: pontos.map((p) => (p.assunto === estado.assunto ? '#0c2540' : CORES[p.grupo])), borderWidth: pontos.map((p) => (p.assunto === estado.assunto ? 3 : 1)) }] },
      options: {
        responsive: true, maintainAspectRatio: false, layout: { padding: { top: 14, right: 22, bottom: 4, left: 4 } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => i[0].raw.assunto, label: (i) => [`${n0(i.raw.n)} processos`, `${i.raw.y.toLocaleString('pt-BR')}% acima do prazo`, `${i.raw.x.toLocaleString('pt-BR')}% chegaram em 30 dias`, i.raw.status] } } },
        scales: {
          x: { min: -5, max: 105, ...marcas(10), title: { display: true, text: 'Chegaram nos últimos 30 dias (%)  →  mais processo novo' }, ticks: { callback: (v) => v + '%' }, grid: { color: '#eef1f5' } },
          y: { min: -8, max: 108, ...marcas(20), title: { display: true, text: 'Acima do prazo (%)  →  acervo mais velho' }, ticks: { callback: (v) => v + '%' }, grid: { color: '#eef1f5' } }
        },
        onClick: (evt, els, chart) => { if (!els.length) return; const p = chart.data.datasets[els[0].datasetIndex].data[els[0].index]; setTimeout(() => { estado.assunto = p.assunto; desenhar(); const d = raiz.querySelector('#tnDetalhe'); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 0); }
      },
      plugins: [fundo]
    });
    charts.push(c);
  }

  function graficosDetalhe(dados, a) {
    if (!window.Chart) return;
    const ref = dados.geral;
    const rot = [...dados.meses.map(rotMes), 'Anteriores'];
    const vA = [...dados.meses.map((m) => a.porMes[m] || 0), a.anteriores];
    const vG = [...dados.meses.map((m) => ((ref.porMes[m] || 0) / ref.n) * a.n), (ref.anteriores / ref.n) * a.n].map((x) => Math.round(x * 10) / 10);
    charts.push(new window.Chart(document.getElementById('tnG1'), {
      data: { labels: rot, datasets: [
        { type: 'bar', label: 'Processos deste assunto', data: vA, backgroundColor: '#12355b', order: 2 },
        { type: 'line', label: 'Quanto seria se seguisse o padrão do conjunto', data: vG, borderColor: '#b7791f', backgroundColor: '#b7791f', borderDash: [5, 4], pointRadius: 3, tension: 0.2, order: 1 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    }));
    charts.push(new window.Chart(document.getElementById('tnG2'), {
      type: 'bar',
      data: { labels: FAIXAS.map((f) => f.rot + ' d'), datasets: [
        { label: 'Este assunto', data: FAIXAS.map((f) => Math.round(((a.faixas[f.id] || 0) / a.n) * 1000) / 10), backgroundColor: '#12355b' },
        { label: 'Todos os assuntos', data: FAIXAS.map((f) => Math.round(((ref.faixas[f.id] || 0) / ref.n) * 1000) / 10), backgroundColor: '#9fb0c3' }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + '%' } } } }
    }));
  }

  /* ---------- histórico real (fotos gravadas nas importações) ---------- */
  async function carregarFotos(ctx) {
    if (fotosCache) return fotosCache;
    const r = await ctx.cliente.from('processos_fotos').select('id,data_foto,total,entradas,saidas').order('id', { ascending: true }).limit(500);
    if (r.error) throw new Error(r.error.message);
    fotosCache = r.data || [];
    return fotosCache;
  }
  async function historicoReal(ctx, assunto, total) {
    const box = document.getElementById('tnReal'); if (!box) return;
    try {
      const fotos = await carregarFotos(ctx);
      if (!total && assunto !== estado.assunto) return;
      if (fotos.length < 2) {
        box.innerHTML = `<p class="tn-aviso"><b>Histórico em formação.</b> ${fotos.length} importação(ões) registrada(s) até agora. A cada importação da planilha o sistema grava o acervo, as entradas e as saídas de cada assunto; este gráfico aparece a partir da 2ª importação.</p>`;
        return;
      }
      let serie;
      if (assunto && !total) {
        const r = await ctx.cliente.from('processos_fotos_assuntos').select('foto_id,qtd,entradas,saidas').eq('assunto', assunto).order('foto_id', { ascending: true }).limit(500);
        if (r.error) throw new Error(r.error.message);
        const por = new Map((r.data || []).map((x) => [x.foto_id, x]));
        serie = fotos.map((f) => { const x = por.get(f.id); return { data: f.data_foto, acervo: x ? x.qtd : 0, entradas: x ? x.entradas : null, saidas: x ? x.saidas : null }; });
      } else serie = fotos.map((f) => ({ data: f.data_foto, acervo: f.total, entradas: f.entradas, saidas: f.saidas }));
      if (!total && assunto !== estado.assunto) return;
      box.innerHTML = '<div class="tn-g"><canvas id="tnG3"></canvas></div>';
      const rot = serie.map((x) => new Date(x.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
      charts.push(new window.Chart(document.getElementById('tnG3'), {
        data: { labels: rot, datasets: [
          { type: 'bar', label: 'Entraram na fila', data: serie.map((x) => x.entradas), backgroundColor: '#2f7d5b', maxBarThickness: 44, yAxisID: 'y', order: 3 },
          { type: 'bar', label: 'Saíram da fila', data: serie.map((x) => x.saidas), backgroundColor: '#b7791f', maxBarThickness: 44, yAxisID: 'y', order: 3 },
          { type: 'line', label: 'Acervo (processos na fila)', data: serie.map((x) => x.acervo), borderColor: '#12355b', backgroundColor: '#12355b', tension: 0.2, pointRadius: 3, yAxisID: 'y1', order: 1 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } },
          scales: { y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Entradas e saídas' }, ticks: { precision: 0 } },
                    y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Acervo' }, ticks: { precision: 0 } } } }
      }));
    } catch (e) {
      box.innerHTML = `<p class="tn-aviso">Não foi possível carregar o histórico das importações (${esc(e.message)}). Verifique se o SQL 10 foi executado e se a função de cadastros está atualizada.</p>`;
    }
  }

  function exportarCSV(dados, visiveis, prazo) {
    const cel = (v) => { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const cols = cabecalho(dados);
    const linhas = [['Assunto', 'Processos', 'Idade mediana (dias)', 'Percentil 90 (dias)', `% acima de ${prazo} dias`, '% chegaram nos ultimos 30 dias', 'Situacao', 'Chegada em volume', '% dos processos novos do conjunto', ...cols]];
    for (const a of visiveis) linhas.push([a.assunto, a.n, a.mediana, a.p90, Math.round(a.pAcima * 1000) / 10, Math.round(a.pRecente * 1000) / 10, a.status, a.volume ? 'sim' : 'nao', Math.round(a.fatiaNovos * 1000) / 10, ...valoresLinha(a, dados)]);
    const csv = '﻿' + linhas.map((l) => l.map(cel).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'SAMP-perfil-de-chegada-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- glossário: botão "Entender os termos" ---------- */
  function glossario(dados, prazo) {
    const g = dados.geral;
    const limParado = Math.max(g.pAcima * 1.5, g.pAcima + 0.10);
    const limMed = Math.max(g.mediana * 1.5, g.mediana + 30);
    const limChega = Math.max(g.pRecente * 1.5, g.pRecente + 0.10);
    const pctLim = (x) => (x > 1 ? 'mais de 100% (impossível; só vale o critério da idade mediana)' : pc(x) + ' ou mais');
    const ex = (grupo, nome) => `<span class="tn2-chip g-${grupo}">${nome}</span>`;
    const item = (titulo, texto) => `<dt>${titulo}</dt><dd>${texto}</dd>`;
    return `
      <div class="tn2-dlg-cab"><h3>Entender os termos</h3><button type="button" class="tn2-dlg-x" aria-label="Fechar" id="tnGlosX">&times;</button></div>
      <div class="tn2-dlg-corpo">
        <p class="tn2-dlg-intro">Esta aba compara cada assunto com o <b>conjunto</b> (todos os assuntos juntos${estado.escopo === 'todos' ? '' : ' do recorte escolhido'}). Os números abaixo estão com os valores de hoje.</p>
        <h4>Situação do assunto</h4>
        <dl>
          ${item(ex('parado', 'Acervo velho'), `Os processos do assunto estão <b>mais velhos do que o normal</b> em comparação com os demais. Exige pelo menos 10 processos e uma destas condições:<br>• a parte dos processos com <b>mais de ${prazo} dias</b> é ${pctLim(limParado)} (no conjunto hoje: ${pc(g.pAcima)}); ou<br>• a <b>idade mediana</b> é de <b>${n0(limMed)} dias ou mais</b> (no conjunto hoje: ${n0(g.mediana)}).<br><small>Em outras palavras: pelo menos 1,5 vez o conjunto e, ao mesmo tempo, 10 pontos percentuais (ou 30 dias) acima. Não é prazo legal vencido: é uma comparação entre assuntos.</small>`)}
          ${item(ex('chegada', 'Chegada alta'), `Está <b>chegando muito processo novo</b>: a parte dos processos que chegou nos últimos 30 dias é ${pctLim(limChega)} (no conjunto hoje: ${pc(g.pRecente)}). É um alerta antecipado: se a chegada continuar e a saída não acompanhar, o assunto tende a acumular.`)}
          ${item(ex('ambos', 'Acervo velho e chegada alta'), 'As duas coisas ao mesmo tempo: já há processo velho acumulado e continua entrando muito processo novo. É o caso que mais merece atenção.')}
          ${item(ex('volume', 'Chegada em volume'), `Selo <b>à parte</b>, que pode aparecer junto de qualquer situação. Indica um assunto que <b>recebe mais processos novos do que o tamanho do seu acervo</b>. Vale quando o assunto tem ao menos ${VOL_MIN_NOVOS} processos novos (últimos 30 dias), concentra ${pc(VOL_MIN_FATIA)} ou mais dos processos novos do conjunto e essa fatia é ${VOL_RAZAO.toLocaleString('pt-BR')} vez ou mais a fatia do acervo que ele tem. Exemplo: um assunto com 10% do acervo que recebe 15% dos processos novos. Serve para pegar assuntos grandes que estão crescendo mais do que o resto, mesmo quando a proporção dentro do assunto não é tão alta.`)}
          ${item(ex('normal', 'Normal'), 'O assunto está dentro do padrão do conjunto: não se destaca nem pela idade nem pela chegada recente.')}
          ${item(ex('poucos', 'Poucos processos'), `Menos de ${MIN_AMOSTRA} processos. Com tão poucos, os percentuais variam demais (um processo muda tudo), então o assunto não é classificado.`)}
        </dl>
        <h4>Números e colunas</h4>
        <dl>
          ${item('Conjunto', 'Todos os assuntos somados (exceto "Registro nulo", que não entra nesta aba). É a régua usada para comparar cada assunto.')}
          ${item('Idade (dias)', 'Quantos dias o processo está na tarefa, segundo a planilha ("Dias na Tarefa"). Não é o tempo desde o ajuizamento: se o processo voltou para a tarefa, ele parece mais novo.')}
          ${item('Idade mediana', 'O valor do meio: metade dos processos do assunto tem <b>mais</b> dias que isso, e metade tem menos. É melhor que a média porque poucos processos muito antigos não distorcem o resultado.')}
          ${item('Percentil 90', 'Nove em cada dez processos têm idade <b>menor ou igual</b> a esse valor. Mostra o tamanho da "cauda" de processos mais antigos.')}
          ${item(`Acima de ${prazo} dias`, `Percentual de processos com mais de ${prazo} dias na tarefa. O limite é o prazo "Normal" configurado em Cadastros &gt; Prazos.`)}
          ${item('Chegaram nos últimos 30 dias', 'Percentual de processos com 30 dias ou menos na tarefa, isto é, os que entraram no último mês.')}
          ${item('p.p. (pontos percentuais)', 'Diferença entre dois percentuais. Se o assunto tem 70% e o conjunto 56%, a diferença é de +14 p.p.')}
        </dl>
        <h4>Gráficos e visualizações</h4>
        <dl>
          ${item('Bolhas ("Onde cada assunto está")', 'Cada bolha é um assunto. O tamanho mostra quantos processos ele tem; a posição vertical, o percentual acima do prazo; a horizontal, o percentual que chegou em 30 dias. As linhas tracejadas marcam o valor do conjunto e dividem os quatro cantos: Normal, Acervo velho, Chegada alta e os dois juntos.')}
          ${item('Barra colorida de idade', 'Divide os processos do assunto por faixa de idade, do verde (mais novos) ao vinho (mais antigos). Quanto mais laranja e vermelho, mais velho o acervo.')}
          ${item('Mapa de calor', 'Tabela em que a cor mais escura indica mais processos. Pode ser lida por <b>mês de chegada</b> (quando o processo entrou, estimado) ou por <b>faixa de idade</b>. "% da linha" mostra a distribuição de cada assunto em vez da quantidade.')}
          ${item('Linha pontilhada "se seguisse o padrão"', 'No gráfico de chegada por mês, mostra quantos processos o assunto teria em cada mês se tivesse a mesma distribuição do conjunto. Barras muito acima da linha indicam um mês em que o assunto recebeu mais que o normal.')}
        </dl>
        <h4>Histórico real e limites</h4>
        <dl>
          ${item('Estimativa', `A data de chegada de cada processo é <b>calculada</b> (data da importação, ${dados.ref.toLocaleDateString('pt-BR')}, menos os dias na tarefa) e só considera os processos que <b>ainda estão na fila</b>. Por isso a aba mostra onde o acervo está envelhecendo, e não quantos já foram resolvidos.`)}
          ${item('Acervo', 'Quantos processos do assunto estão na fila naquele momento (uma "foto" gravada a cada importação).')}
          ${item('Entraram na fila / Saíram da fila', 'Comparação entre duas importações seguidas: <b>entraram</b> são os números que aparecem na nova e não estavam na anterior; <b>saíram</b> são os que sumiram da planilha. Sair da fila não significa, necessariamente, que o processo foi calculado. Só existe a partir da 2ª importação.')}
        </dl>
      </div>`;
  }
  function abrirGlossario(dados, prazo) {
    let dlg = document.getElementById('tnDlg');
    if (!dlg) {
      dlg = document.createElement('dialog'); dlg.id = 'tnDlg'; dlg.className = 'tn2-dlg';
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // clique fora fecha
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = glossario(dados, prazo);
    dlg.querySelector('#tnGlosX').onclick = () => dlg.close();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  /* ---------- tela ---------- */
  function desenhar() {
    const ctx = ctxAtual; limparGraficos();
    const dados = calcular(ctx), g = dados.geral;
    if (!g.n) { raiz.innerHTML = '<div class="empty-state"><div>Nenhum processo neste recorte.</div></div>'; return; }
    const prazo = ctx.prazo;
    const porAtencao = [...dados.itens].sort((a, b) => (b.gravidade - a.gravidade) || (Number(b.volume) - Number(a.volume)) || (b.n - a.n)).filter((a) => a.gravidade > 0 || a.volume);
    const ordenados = ordenar(dados.itens);
    const visiveis = estado.todos ? ordenados : ordenados.slice(0, 12);
    if (!estado.assunto || !dados.itens.find((x) => x.assunto === estado.assunto)) estado.assunto = (porAtencao[0] || ordenados[0] || {}).assunto || null;
    const sel = dados.itens.find((x) => x.assunto === estado.assunto);

    raiz.innerHTML = `
      <div class="tn2-topo">
        <div>
          <h3>Perfil de chegada e envelhecimento por assunto</h3>
          <p class="tn2-sub">Mostra quais assuntos estão com processos aguardando há muito tempo e quais estão recebendo muito processo novo, comparando cada um com o conjunto.</p>
        </div>
        <div class="tn2-topo-dir">
        <button type="button" class="btn tn2-glos" id="tnGlos">? Entender os termos</button>
        <label class="tn2-rec">Recorte <select id="tnEscopo"><option value="todos">Todas as varas</option><option value="comum">Varas comuns (1 a 22)</option><option value="jef">JEF (23 a 27)</option></select></label>
        </div>
      </div>

      <div class="tn2-resumo">${resumo(dados, prazo)}</div>

      <p class="tn2-estim">Valores <b>estimados</b> a partir dos dias na tarefa dos processos que ainda estão na fila (importação de ${dados.ref.toLocaleDateString('pt-BR')}). Em dúvida sobre algum termo, use o botão <b>? Entender os termos</b>, no alto da página.</p>

      <h3 class="tn2-h">Assuntos que pedem atenção</h3>
      ${porAtencao.length
        ? `<div class="tn2-cards">${porAtencao.slice(0, 6).map((a) => cartaoAtencao(a, g, prazo)).join('')}</div>${porAtencao.length > 6 ? `<p class="tn2-mais">e mais ${porAtencao.length - 6} assunto(s) na lista abaixo.</p>` : ''}`
        : '<div class="tn2-ok">Nenhum assunto está fora do padrão do conjunto neste momento. Confira a lista completa abaixo.</div>'}

      <h3 class="tn2-h">Onde cada assunto está <small>clique em uma bolha para ver o detalhe</small></h3>
      <div class="chart-card"><div class="tn-g tn2-sit"><canvas id="tnSit"></canvas></div>
        <p class="tn2-nota">Cada bolha é um assunto, e o tamanho indica quantos processos ele tem. As linhas tracejadas marcam o valor do conjunto: quanto mais para cima, mais velho o acervo; quanto mais para a direita, mais processo novo chegando.</p></div>

      <h3 class="tn2-h">Todos os assuntos
        <span class="tn2-ord" role="group" aria-label="Ordenar">
          <button data-ordem="atencao" class="${estado.ordem === 'atencao' ? 'on' : ''}">Precisam de atenção</button>
          <button data-ordem="acervo" class="${estado.ordem === 'acervo' ? 'on' : ''}">Maior acervo</button>
          <button data-ordem="idade" class="${estado.ordem === 'idade' ? 'on' : ''}">Mais velhos</button>
        </span></h3>
      ${legendaIdade()}
      <div class="tn2-cab"><span>Assunto</span><span>Processos</span><span>Como estão distribuídos por idade</span><span title="Idade mediana: metade dos processos tem mais que isso">Idade mediana</span><span>Situação</span></div>
      ${listaAssuntos(visiveis, g)}
      ${dados.itens.length > 12 ? `<button class="btn tn2-vermais" id="tnTodos">${estado.todos ? 'Mostrar só os 12 primeiros' : `Ver todos os ${dados.itens.length} assuntos`}</button>` : ''}

      ${sel ? `<div id="tnDetalhe" class="tn2-detalhe">
        <h3 class="tn2-h">Detalhe: ${esc(sel.assunto)} ${chip(sel)}</h3>
        <div class="tn2-frase">${frase(sel, g, prazo)}</div>
        <div class="tn-duo">
          <div class="chart-card"><h4>Quando os processos chegaram (por mês)</h4><div class="tn-g"><canvas id="tnG1"></canvas></div></div>
          <div class="chart-card"><h4>Idade dos processos: este assunto × todos</h4><div class="tn-g"><canvas id="tnG2"></canvas></div></div>
        </div></div>` : ''}

      <h3 class="tn2-h">Evolução real a cada importação <small>${sel ? esc(sel.assunto) : ''}</small>
        ${sel ? '<button class="lnk" id="tnTodosReal">ver o total de todos os assuntos</button>' : ''}</h3>
      <div class="chart-card"><div id="tnReal"><p class="tn-aviso">Carregando...</p></div></div>
      <p class="tn2-nota" style="margin-top:6px">"Saíram da fila" significa que o processo deixou de constar na planilha; não necessariamente que foi calculado.</p>

      <details class="tn2-av" id="tnAv" ${estado.avancado ? 'open' : ''}><summary>Detalhes técnicos: mapa de calor e tabela completa</summary>
        <div class="tn-ctl">
          <div class="tn-seg" role="group" aria-label="Eixo do mapa de calor"><button data-modo="mes" class="${estado.modo === 'mes' ? 'on' : ''}">Mês de chegada</button><button data-modo="faixa" class="${estado.modo === 'faixa' ? 'on' : ''}">Faixa de idade</button></div>
          <label class="tn-chk"><input type="checkbox" id="tnPct" ${estado.pct ? 'checked' : ''}> % da linha</label>
          <button class="btn" id="tnCsv">Exportar CSV</button>
        </div>
        <h4 class="tn-h">Mapa de calor: assuntos × ${estado.modo === 'mes' ? 'mês de chegada' : 'faixa de idade'}</h4>
        ${mapaCalor(dados, visiveis)}
        <h4 class="tn-h">Comparação de cada assunto com o conjunto</h4>
        ${tabelaComparacao(dados, visiveis, prazo)}
      </details>`;

    document.getElementById('tnEscopo').value = estado.escopo;
    ['tnGlos', 'tnGlos2'].forEach((id) => { const b = document.getElementById(id); if (b) b.onclick = () => abrirGlossario(dados, prazo); });
    document.getElementById('tnEscopo').onchange = (e) => { estado.escopo = e.target.value; desenhar(); };
    const t = document.getElementById('tnTodos'); if (t) t.onclick = () => { estado.todos = !estado.todos; desenhar(); };
    raiz.querySelectorAll('.tn2-ord button').forEach((b) => { b.onclick = () => { estado.ordem = b.dataset.ordem; desenhar(); }; });
    raiz.querySelectorAll('.tn-seg button').forEach((b) => { b.onclick = () => { estado.modo = b.dataset.modo; estado.avancado = true; desenhar(); }; });
    document.getElementById('tnPct').onchange = (e) => { estado.pct = e.target.checked; estado.avancado = true; desenhar(); };
    document.getElementById('tnCsv').onclick = () => exportarCSV(dados, ordenados, prazo);
    document.getElementById('tnAv').addEventListener('toggle', (e) => { estado.avancado = e.target.open; });
    const tr = document.getElementById('tnTodosReal'); if (tr) tr.onclick = () => historicoReal(ctx, null, true);
    graficoSituacao(dados);
    if (sel) graficosDetalhe(dados, sel);
    historicoReal(ctx, sel ? sel.assunto : null, !sel);
  }

  window.renderTendencia = function (container, ctx) {
    ctxAtual = ctx; raiz = container;
    if (!raiz._tn) {
      raiz._tn = true;
      raiz.addEventListener('click', (e) => {   // clicar em um cartão, linha ou célula escolhe o assunto do detalhe
        const el = e.target.closest('[data-assunto]'); if (!el || !raiz.contains(el)) return;
        const rolar = !el.closest('.tn-heat, .tn-cmp');
        estado.assunto = el.dataset.assunto; desenhar();
        if (rolar) { const alvo = raiz.querySelector('#tnDetalhe'); if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
    }
    fotosCache = null;
    desenhar();
  };
})();
