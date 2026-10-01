// Gerador de relatórios do SAMP (PDF e CSV) a partir do "spec" montado pela Sampinha.
// Roda inteiramente no navegador: nada é enviado a terceiros. Bibliotecas carregadas sob demanda.
(function () {
  const LIBS = {
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
    chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
  };
  const COR = { navy: [18, 53, 91], dark: [12, 37, 64], gold: [166, 138, 78], ink: [31, 41, 55], muted: [95, 107, 122], line: [211, 217, 224], zebra: [247, 248, 250] };
  const PALETA = ['#12355b', '#2f7d5b', '#b7791f', '#b3261e', '#6c8cb0', '#5f6b7a', '#7a4b3a', '#8c6bb1'];

  const carregar = (src) => new Promise((ok, falha) => {
    const s = document.createElement('script'); s.src = src; s.onload = ok;
    s.onerror = () => falha(new Error('Não foi possível carregar uma biblioteca necessária (verifique a conexão).')); document.head.appendChild(s);
  });
  async function garantirLibs() {
    if (!window.jspdf) await carregar(LIBS.jspdf);
    if (!window.jspdf.jsPDF.API.autoTable) await carregar(LIBS.autotable);
    if (!window.Chart) await carregar(LIBS.chart);
  }
  // fontes padrão do PDF aceitam Latin-1 (acentos do português); o restante é simplificado
  const t = (x) => String(x ?? '').replace(/[–—−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/ /g, ' ').replace(/[^\u0000-ÿ]/g, '?');

  /* ---------- gráfico -> imagem ---------- */
  function imagemGrafico(sec) {
    const horiz = sec.grafico === 'barras_horizontais', pizza = sec.grafico === 'pizza';
    const largura = 1000, altura = horiz ? Math.max(380, 36 * sec.rotulos.length + 130) : pizza ? 520 : 460;
    const canvas = document.createElement('canvas'); canvas.width = largura; canvas.height = altura;
    const varias = sec.series.length > 1;
    const datasets = sec.series.map((s, i) => {
      const cor = PALETA[i % PALETA.length];
      if (pizza) return { label: s.nome, data: s.dados, backgroundColor: sec.rotulos.map((_, k) => (sec.rotulos.length === 3 && /prazo|aten|atras/i.test(sec.rotulos[k]) ? ['#2f7d5b', '#b7791f', '#b3261e'][k] : PALETA[k % PALETA.length])), borderColor: '#fff', borderWidth: 2 };
      if (sec.grafico === 'linha') return { label: s.nome, data: s.dados, borderColor: cor, backgroundColor: cor, borderWidth: 2.5, pointRadius: 3, tension: 0.2, fill: false };
      return { label: s.nome, data: s.dados, backgroundColor: cor };
    });
    const tipo = pizza ? 'pie' : sec.grafico === 'linha' ? 'line' : 'bar';
    const chart = new window.Chart(canvas.getContext('2d'), {
      type: tipo,
      data: { labels: sec.rotulos.map(t), datasets },
      options: {
        animation: false, responsive: false, devicePixelRatio: 1, indexAxis: horiz ? 'y' : 'x',
        layout: { padding: 12 },
        plugins: { legend: { display: varias || pizza, position: pizza ? 'right' : 'bottom', labels: { font: { size: 16 }, boxWidth: 18 } } },
        scales: pizza ? {} : {
          x: { ticks: { font: { size: 14 }, maxRotation: horiz ? 0 : 60, autoSkip: true }, grid: { color: '#e6eaef' } },
          y: { ticks: { font: { size: 14 } }, grid: { color: '#e6eaef' }, beginAtZero: true }
        }
      },
      plugins: [{ id: 'fundo', beforeDraw(c) { const x = c.ctx; x.save(); x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.restore(); } }]
    });
    const img = canvas.toDataURL('image/png');
    chart.destroy();
    return { img, proporcao: altura / largura };
  }

  /* ---------- PDF ---------- */
  async function baixarPDF(spec, usuario) {
    await garantirLibs();
    const largas = spec.secoes.some((s) => s.tipo === 'tabela' && s.colunas.length > 6);
    const paisagem = spec.orientacao === 'paisagem' || largas;
    const doc = new window.jspdf.jsPDF({ orientation: paisagem ? 'l' : 'p', unit: 'mm', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14, TOPO = 20, RODAPE = 16;
    const util = W - 2 * M;
    let y = 0;

    // capa / cabeçalho da primeira página
    doc.setFillColor(...COR.dark); doc.rect(0, 0, W, 24, 'F');
    doc.setFillColor(...COR.gold); doc.rect(0, 24, W, 1.2, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('SAMP', M, 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(t('Sistema de Acompanhamento e Métricas Processuais'), M, 19.5);
    y = 36;
    doc.setTextColor(...COR.navy); doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
    const titulo = doc.splitTextToSize(t(spec.titulo), util); doc.text(titulo, M, y); y += titulo.length * 7;
    if (spec.subtitulo) { doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...COR.muted); const st = doc.splitTextToSize(t(spec.subtitulo), util); doc.text(st, M, y); y += st.length * 5.2; }
    const quando = new Date().toLocaleString('pt-BR');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...COR.muted);
    doc.text(t(`Gerado por ${usuario ? usuario.nome + ' (matrícula ' + usuario.matricula + ')' : 'usuário SAMP'} em ${quando}`), M, y + 1);
    if (spec.interpretacao) {
      y += 5.5; doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...COR.ink);
      const esc = doc.splitTextToSize(t('Escopo: ' + spec.interpretacao), util); doc.text(esc, M, y); y += (esc.length - 1) * 4.2;
    }
    y += 5; doc.setDrawColor(...COR.line); doc.line(M, y, W - M, y); y += 7;

    const espaco = (h) => { if (y + h > H - RODAPE) { doc.addPage(); y = TOPO; } };
    const tituloSecao = (txt) => { if (!txt) return; espaco(14); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...COR.navy); doc.text(t(txt), M, y); y += 2; doc.setDrawColor(...COR.gold); doc.setLineWidth(0.5); doc.line(M, y, M + 18, y); doc.setLineWidth(0.2); y += 5.5; };

    for (const sec of spec.secoes) {
      if (sec.tipo === 'texto') {
        tituloSecao(sec.titulo);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...COR.ink);
        for (const par of String(sec.conteudo).split(/\n+/)) {
          if (!par.trim()) continue;
          for (const linha of doc.splitTextToSize(t(par), util)) { espaco(5.2); doc.text(linha, M, y); y += 5; }
          y += 1.8;
        }
        y += 3;

      } else if (sec.tipo === 'kpis') {
        tituloSecao(sec.titulo);
        const porLinha = Math.min(sec.itens.length, paisagem ? 5 : 4), gap = 3, w = (util - gap * (porLinha - 1)) / porLinha, h = 18;
        sec.itens.forEach((it, i) => {
          const col = i % porLinha;
          if (col === 0) espaco(h + 3);
          const x = M + col * (w + gap);
          doc.setDrawColor(...COR.line); doc.setFillColor(255, 255, 255); doc.rect(x, y, w, h, 'FD');
          doc.setFillColor(...COR.navy); doc.rect(x, y, w, 1.2, 'F');
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...COR.muted); doc.text(doc.splitTextToSize(t(it.rotulo).toUpperCase(), w - 4)[0], x + 2.5, y + 6.2);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...COR.navy); doc.text(t(it.valor), x + 2.5, y + 14);
          if (col === porLinha - 1 || i === sec.itens.length - 1) y += h + gap;
        });
        y += 4;

      } else if (sec.tipo === 'tabela') {
        tituloSecao(sec.titulo);
        const numerica = sec.colunas.map((_, c) => sec.linhas.length && sec.linhas.every((l) => /^-?[\d.,]+%?$/.test(String(l[c] ?? '').trim())));
        doc.autoTable({
          startY: y, head: [sec.colunas.map(t)], body: sec.linhas.map((l) => l.map(t)),
          margin: { top: TOPO, left: M, right: M, bottom: RODAPE },
          styles: { font: 'helvetica', fontSize: paisagem ? 8 : 8.5, cellPadding: 1.8, textColor: COR.ink, lineColor: COR.line, lineWidth: 0.1, overflow: 'linebreak' },
          headStyles: { fillColor: COR.navy, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: COR.zebra },
          columnStyles: Object.fromEntries(numerica.map((n, c) => [c, n ? { halign: 'right' } : {}]))
        });
        y = doc.lastAutoTable.finalY + 3;
        if (sec.nota) { espaco(6); doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(...COR.muted); doc.text(t(sec.nota), M, y + 1); y += 5; }
        y += 4;

      } else if (sec.tipo === 'grafico') {
        const { img, proporcao } = imagemGrafico(sec);
        const h = Math.min(util * proporcao, paisagem ? 92 : 115, H - TOPO - RODAPE - 12), w = h / proporcao;
        espaco(h + 14); tituloSecao(sec.titulo);
        espaco(h + 2);
        doc.addImage(img, 'PNG', M + (util - w) / 2, y, w, h, undefined, 'FAST'); y += h + 6;
      }
    }

    // cabeçalho das páginas seguintes e rodapé de todas
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p);
      if (p > 1) {
        doc.setFillColor(...COR.dark); doc.rect(0, 0, W, 9, 'F'); doc.setFillColor(...COR.gold); doc.rect(0, 9, W, 0.6, 'F');
        doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('SAMP', M, 6);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(doc.splitTextToSize(t(spec.titulo), util - 20)[0], W - M, 6, { align: 'right' });
      }
      doc.setDrawColor(...COR.line); doc.line(M, H - 12, W - M, H - 12);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...COR.muted);
      doc.text('SAMP - Sistema de Acompanhamento e Métricas Processuais', M, H - 8);
      doc.text(t('Gerado automaticamente com apoio de IA. Revise as informações antes de divulgar.'), M, H - 4.5);
      doc.text(`Página ${p} de ${n}`, W - M, H - 8, { align: 'right' });
    }
    const slug = String(spec.titulo).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'relatorio';
    doc.save(`SAMP-${slug}-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  /* ---------- CSV (tabelas e dados dos gráficos) ---------- */
  const temTabelas = (spec) => spec.secoes.some((s) => s.tipo === 'tabela' || s.tipo === 'grafico' || s.tipo === 'kpis');
  function baixarCSV(spec) {
    const cel = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const linhas = [[spec.titulo], []];
    for (const s of spec.secoes) {
      if (s.tipo === 'tabela') { linhas.push([s.titulo || 'Tabela'], s.colunas, ...s.linhas, []); }
      else if (s.tipo === 'kpis') { linhas.push([s.titulo || 'Indicadores'], ...s.itens.map((i) => [i.rotulo, i.valor]), []); }
      else if (s.tipo === 'grafico') { linhas.push([(s.titulo || 'Gráfico') + ' (dados)'], ['', ...s.series.map((x) => x.nome)], ...s.rotulos.map((r, i) => [r, ...s.series.map((x) => x.dados[i])]), []); }
    }
    const csv = '﻿' + linhas.map((l) => l.map(cel).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `SAMP-${new Date().toISOString().slice(0, 10)}-dados.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  window.SAMP_RELATORIO = { baixarPDF, baixarCSV, temTabelas };
})();
