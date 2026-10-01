// Acabamento de interface compartilhado do SAMP: transições de página, contagem animada de números,
// indicador deslizante nas abas, revelação ao rolar e destaque da seção ativa. Tudo respeita
// "reduzir animações" do sistema e é puramente visual (não altera dados nem funções das páginas).
(function () {
  const reduzir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- transição suave entre páginas do SAMP ---------- */
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button || a.target === '_blank') return;
    if (reduzir || !/^[\w-]+\.html(\?.*)?$/.test(a.getAttribute('href'))) return;
    e.preventDefault();
    document.body.classList.add('saindo');
    setTimeout(() => { location.href = a.getAttribute('href'); }, 190);
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) document.body.classList.remove('saindo'); });

  /* ---------- números que "contam" até o valor ---------- */
  const SEL = '.kpi .k-v, .stat-card .value, .kp2-v, .mt-v';
  function interpretar(txt) {
    const t = txt.trim();
    if (!/^[\d.,]+$/.test(t)) return null;
    if (t.includes(',')) return { n: parseFloat(t.replace(/\./g, '').replace(',', '.')), dec: t.split(',')[1].length };
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) return { n: parseInt(t.replace(/\./g, ''), 10), dec: 0 };
    if (/^\d+(\.\d+)?$/.test(t)) return { n: parseFloat(t), dec: (t.split('.')[1] || '').length };
    return null;
  }
  const formatar = (n, dec) => n.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  function animar(el) {
    const final = el.textContent;
    if (el.dataset.final === final) return;
    const p = interpretar(final);
    if (!p || !isFinite(p.n)) return;
    el.dataset.final = final;
    if (reduzir || p.n === 0) return;
    const t0 = performance.now(), D = 750;
    el.dataset.animando = '1';
    (function passo(t) {
      const k = Math.max(0, Math.min(1, (t - t0) / D)), suave = 1 - Math.pow(1 - k, 3);
      if (k < 1) { el.textContent = formatar(p.n * suave, p.dec); requestAnimationFrame(passo); }
      else { el.textContent = final; delete el.dataset.animando; }
    })(t0);
  }
  let agendado = false;
  function varrer() {
    agendado = false;
    document.querySelectorAll(SEL).forEach((el) => { if (!el.dataset.animando) animar(el); });
    document.querySelectorAll('.tabs:not(.com-ind)').forEach(indicador);
    revelar();
  }
  new MutationObserver(() => { if (!agendado) { agendado = true; requestAnimationFrame(varrer); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true });

  /* ---------- indicador deslizante nas abas ---------- */
  function indicador(tabs) {
    if (!tabs.querySelector('.tab')) return;
    const ind = document.createElement('span');
    ind.className = 'tab-ind';
    tabs.appendChild(ind);
    tabs.classList.add('com-ind');
    const posicionar = () => {
      const a = tabs.querySelector('.tab.active');
      if (!a) { ind.style.opacity = 0; return; }
      ind.style.opacity = 1; ind.style.width = a.offsetWidth + 'px'; ind.style.transform = `translateX(${a.offsetLeft}px)`;
    };
    new MutationObserver(posicionar).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', posicionar);
    posicionar(); setTimeout(posicionar, 350);
  }

  /* ---------- revelar seções ao rolar ---------- */
  let io = null;
  function revelar() {
    if (reduzir || !('IntersectionObserver' in window)) return;
    if (!io) io = new IntersectionObserver((itens) => itens.forEach((i) => { if (i.isIntersecting) { i.target.classList.add('in'); io.unobserve(i.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
    document.querySelectorAll('.section:not(.reveal), .chart-card:not(.reveal)').forEach((el) => {
      el.classList.add('reveal'); io.observe(el);
      setTimeout(() => el.classList.add('in'), 2500);   // segurança: nada fica oculto
    });
  }

  /* ---------- destaque da seção visível (menu de seções das Metas) ---------- */
  function observarSecoes() {
    const links = [...document.querySelectorAll('.subnav a[href^="#"]')];
    if (!links.length || !('IntersectionObserver' in window)) return;
    const alvos = links.map((l) => document.querySelector(l.getAttribute('href'))).filter(Boolean);
    const spy = new IntersectionObserver((itens) => itens.forEach((i) => {
      if (i.isIntersecting) links.forEach((l) => l.classList.toggle('ativo', l.getAttribute('href') === '#' + i.target.id));
    }), { rootMargin: '-30% 0px -60% 0px' });
    alvos.forEach((a) => spy.observe(a));
  }

  /* ---------- botão de voltar ao topo ---------- */
  const topo = document.createElement('button');
  topo.type = 'button'; topo.className = 'ao-topo'; topo.setAttribute('aria-label', 'Voltar ao topo'); topo.innerHTML = '&uarr;';
  topo.onclick = () => window.scrollTo({ top: 0, behavior: reduzir ? 'auto' : 'smooth' });
  document.body.appendChild(topo);
  window.addEventListener('scroll', () => { topo.classList.toggle('on', window.scrollY > 600); document.body.classList.toggle('rolou', window.scrollY > 90); }, { passive: true });

  document.addEventListener('DOMContentLoaded', () => { varrer(); observarSecoes(); });
  if (document.readyState !== 'loading') { varrer(); observarSecoes(); }
})();
