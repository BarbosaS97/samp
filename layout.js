// Estrutura comum do SAMP: controle de acesso por matrícula, barra de navegação e rodapé.
// Cada página informa a sua posição com <body data-page="inicio|analise|metricas|cadastros|entrar">.
(function () {
  const ITENS = [
    { id: 'inicio',    href: 'index.html',     texto: 'Início' },
    { id: 'analise',   href: 'analise.html',   texto: 'Análise de Processos' },
    { id: 'metricas',  href: 'metricas.html',  texto: 'Metas Processuais' },
    { id: 'cadastros', href: 'cadastros.html', texto: 'Cadastros', restrito: true }
  ];
  const atual = document.body.dataset.page;
  const publica = atual === 'entrar' || atual === 'cadastros';   // Cadastros tem a própria senha

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
    '<a class="brand" href="index.html">SAMP<small>Acompanhamento e Métricas Processuais</small></a>' +
    (atual === 'entrar' ? '' :
      '<nav aria-label="Navegação principal">' +
      ITENS.map(i =>
        `<a href="${i.href}"${i.id === atual ? ' class="active" aria-current="page"' : ''}>${i.texto}${i.restrito ? '<span class="lock" title="Acesso restrito"></span>' : ''}</a>`
      ).join('') +
      (sessao ? `<span class="user" title="Matrícula ${esc(sessao.matricula)}">Olá, <b>${esc(nomeProprio(sessao.nome))}</b></span><button class="logout" id="sairSamp" type="button">Sair</button>` : '') +
      '</nav>');
  document.body.prepend(bar);

  const sair = document.getElementById('sairSamp');
  if (sair) sair.onclick = () => { try { sessionStorage.removeItem('samp_sessao'); } catch (e) {} location.href = 'entrar.html?saiu=1'; };

  document.addEventListener('DOMContentLoaded', () => {
    const f = document.createElement('footer');
    f.className = 'app-footer';
    f.innerHTML = '<span>SAMP - Sistema de Acompanhamento e Métricas Processuais</span><span>' + new Date().getFullYear() + '</span>';
    document.body.appendChild(f);
  });

  window.SAMP_USUARIO = sessao;   // { nome, matricula, token, exp } ou null

  // acabamento visual compartilhado (animações, abas, números); não é usado na tela de acesso
  if (atual !== 'entrar') { const u = document.createElement('script'); u.src = 'ui.js?v=20261001a'; document.body.appendChild(u); }
})();
