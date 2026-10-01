-- PASSO 4: tabela de matrículas autorizadas a acessar o SAMP.
-- Fica totalmente fechada para o público: só a função "cadastros-function" (service role) lê e grava.
create table if not exists public.usuarios (
  matricula     text primary key,
  nome          text not null,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  ultimo_acesso timestamptz
);

alter table public.usuarios enable row level security;
alter table public.usuarios force row level security;
revoke all on public.usuarios from anon, authenticated;
-- (sem nenhuma policy: o público não enxerga nem altera nada nesta tabela)
