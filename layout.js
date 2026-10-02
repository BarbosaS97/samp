// Estrutura comum do SAMP: controle de acesso por matrícula, barra de navegação e rodapé.
// Cada página informa a sua posição com <body data-page="inicio|analise|metricas|producao|ajuda|cadastros|entrar">.
(function () {
  const ITENS = [
    { id: 'inicio',    href: 'index.html',     texto: 'Início' },
    { id: 'analise',   href: 'analise.html',   texto: 'Análise de Processos' },
    { id: 'metricas',  href: 'metricas.html',  texto: 'Metas Processuais' },
    { id: 'producao',  href: 'producao.html',  texto: 'Produção Individual' },
    { id: 'ajuda',     href: 'ajuda.html',     texto: 'O que tem no SAMP?' },
    { id: 'cadastros', href: 'cadastros.html', texto: 'Cadastros', restrito: true }
  ];
  const atual = document.body.dataset.page;
  const publica = atual === 'entrar' || atual === 'cadastros' || atual === 'ajuda';   // Cadastros tem a própria senha; o guia ("Conheça o SAMP") é aberto a todos

  // Sessão de matrícula (sessionStorage), lida direto para este arquivo não depender de outros.
  let sessao = null;
  try {
    const s = JSON.parse(sessionStorage.getItem('samp_sessao') || 'null');
    if (s && s.token && s.exp > Date.now()) sessao = s;
  } catch (e) {}

  if (!publica && !sessao) {
    // sem matrícula autorizada: vai para o login e volta para esta página depois
    document.documentElement.style.visibility = 'hidden';
    const volta = location.pathname.split('/').pop() || 'index.html';
    location.replace('entrar.html?volta=' + encodeURIComponent(volta));
    return;
  }

  const nomeProprio = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR'); };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const bar = document.createElement('header');
  bar.className = 'app-bar';
  bar.innerHTML =
    '<a class="brand" href="index.html"><img class="brand-ico" src="icon.svg" alt="" width="28" height="28">SAMP<small>Sistema de Acompanhamento e Métricas Processuais</small></a>' +
    (atual === 'entrar' ? '' :
      atual === 'ajuda' && !sessao ? '<nav aria-label="Navegação principal"><a href="ajuda.html" data-id="ajuda" class="active" aria-current="page">Conheça o SAMP</a><a href="entrar.html" data-id="entrar">Entrar</a></nav>' :
      '<nav aria-label="Navegação principal">' +
      ITENS.map(i =>
        `<a href="${i.href}" data-id="${i.id}"${i.id === atual ? ' class="active" aria-current="page"' : ''}>${i.texto}${i.restrito ? '<span class="lock" title="Acesso restrito"></span>' : ''}</a>`
      ).join('') +
      (sessao ? `<span class="user" title="Matrícula ${esc(sessao.matricula)}">Olá, <b>${esc(nomeProprio(sessao.nome))}</b></span><button class="logout" id="sairSamp" type="button">Sair</button>` : '') +
      '</nav>');
  document.body.prepend(bar);

  const sair = document.getElementById('sairSamp');
  if (sair) sair.onclick = () => { try { sessionStorage.removeItem('samp_sessao'); } catch (e) {} location.href = 'entrar.html?saiu=1'; };


  /* Aba ativa em "arco": uma curva dourada sobe da linha da barra e envolve o item selecionado.
     Ao trocar de página, o arco desliza da aba anterior até a nova. */
  (function () {
    const nav = bar.querySelector('nav');
    const ativo = nav && nav.querySelector('a.active');
    if (!ativo) return;
    const NS = 'http://www.w3.org/2000/svg', R = 16, T = 5;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'nav-bump'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<defs><linearGradient id="nbG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a68a4e" stop-opacity=".42"/><stop offset="1" stop-color="#a68a4e" stop-opacity="0"/></linearGradient></defs>' +
      '<path class="nb-base"/><path class="nb-glow"/><path class="nb-line"/>';
    nav.insertBefore(svg, nav.firstChild);
    const [pBase, pGlow, pLine] = svg.querySelectorAll('path');
    let atual = null, quadro = 0;

    function geometria(el) { return { l: el.offsetLeft - R, w: el.offsetWidth + 2 * R }; }
    function desenhar(g) {
      const H = nav.clientHeight, rolando = nav.scrollWidth > nav.clientWidth + 1, ext = rolando ? 0 : 3;
      const B = H + (ext ? ext / 2 : -1), baixo = H + ext, W = g.w;
      svg.style.left = g.l + 'px'; svg.style.width = W + 'px'; svg.style.height = baixo + 'px'; svg.style.bottom = (-ext) + 'px';
      svg.setAttribute('viewBox', `0 0 ${W} ${baixo}`);
      const linha = `M0,${B} C${R * 0.55},${B} ${R * 0.45},${T} ${R},${T} L${W - R},${T} C${W - R * 0.45},${T} ${W - R * 0.55},${B} ${W},${B}`;
      const area = linha + ` L${W},${baixo} L0,${baixo} Z`;
      pBase.setAttribute('d', area); pGlow.setAttribute('d', area); pLine.setAttribute('d', linha);
      atual = g;
    }
    function ir(destino, de) {
      cancelAnimationFrame(quadro);
      if (!de || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { desenhar(destino); return; }
      const t0 = performance.now(), dur = 520;
      const ease = (x) => 1 - Math.pow(1 - x, 3) + Math.sin(x * Math.PI) * 0.035;   // chega com um leve “respiro”
      const passo = (agora) => {
        const k = Math.min(1, (agora - t0) / dur), e = ease(k);
        desenhar({ l: de.l + (destino.l - de.l) * e, w: de.w + (destino.w - de.w) * e });
        if (k < 1) quadro = requestAnimationFrame(passo); else desenhar(destino);
      };
      quadro = requestAnimationFrame(passo);
    }

    let anterior = null;
    try { anterior = sessionStorage.getItem('samp_nav_ativo'); sessionStorage.setItem('samp_nav_ativo', atual_id()); } catch (e) {}
    function atual_id() { return ativo.dataset.id || ''; }
    const origem = anterior && anterior !== atual_id() ? nav.querySelector(`a[data-id="${anterior}"]`) : null;
    // começa na aba anterior (sem animar) e desliza até a nova; sem aba anterior, só aparece no lugar
    desenhar(geometria(origem || ativo));
    svg.classList.add('pronto');
    requestAnimationFrame(() => requestAnimationFrame(() => ir(geometria(ativo), origem ? geometria(origem) : null)));

    // em telas estreitas a barra rola de lado: deixa a aba atual visível
    if (nav.scrollWidth > nav.clientWidth + 1) nav.scrollLeft = Math.max(0, ativo.offsetLeft - (nav.clientWidth - ativo.offsetWidth) / 2);
    // ajustes depois que a fonte carrega ou a janela muda de tamanho
    const reposicionar = () => ir(geometria(ativo), null);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(reposicionar);
    if (window.ResizeObserver) new ResizeObserver(reposicionar).observe(nav); else window.addEventListener('resize', reposicionar);
    nav.addEventListener('scroll', () => {}, { passive: true });
  })();

  document.addEventListener('DOMContentLoaded', () => {
    const f = document.createElement('footer');
    f.className = 'app-footer';
    f.innerHTML = '<span>SAMP - Sistema de Acompanhamento e Métricas Processuais</span><span>' + new Date().getFullYear() + '</span>';
    document.body.appendChild(f);
  });

  window.SAMP_USUARIO = sessao;   // { nome, matricula, token, exp } ou null

  // acabamento visual compartilhado (animações, abas, números); não é usado na tela de acesso
  if (atual !== 'entrar') { const u = document.createElement('script'); u.src = 'ui.js?v=20261006a'; document.body.appendChild(u); }

  // PWA: registra o service worker (só quando servido por http/https)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
})();
