-- PASSO 11: módulo "Produção Individual" (produção de cada servidor, vinda das planilhas "PRODUÇÃO SECAJ - Nome").
-- Execute ANTES de publicar a nova cadastros-function.
--
--  producao_itens   : uma linha por processo calculado (data, número do processo, objeto, prioridade, observação,
--                     data de recebimento e tipo META/ACERVO). É a lista que começa na linha 48 de cada planilha.
--  producao_resumo  : uma linha por pessoa com os números já consolidados (mês a mês, por assunto, por dia),
--                     recalculados a cada importação. É o que as telas leem (rápido).
-- Cada importação substitui por inteiro os dados da pessoa (importar de novo não duplica nada).
create table if not exists public.producao_itens (
  id           bigint generated always as identity primary key,
  pessoa       text        not null,
  data         date        not null,
  processo     text        not null,
  objeto       text,
  prioridade   text,
  observacao   text,
  recebido_em  date,
  tipo         text,
  importado_em timestamptz not null
);
create index if not exists idx_producao_itens_pessoa_data on public.producao_itens (pessoa, data);
create index if not exists idx_producao_itens_importado on public.producao_itens (pessoa, importado_em);

create table if not exists public.producao_resumo (
  pessoa        text primary key,
  dados         jsonb       not null,
  total         integer     not null default 0,
  primeira_data date,
  ultima_data   date,
  arquivo       text,
  atualizado_em timestamptz not null default now()
);

alter table public.producao_itens  enable row level security;
alter table public.producao_itens  force row level security;
alter table public.producao_resumo enable row level security;
alter table public.producao_resumo force row level security;
revoke all on public.producao_itens  from anon, authenticated;
revoke all on public.producao_resumo from anon, authenticated;
-- (sem policy: o público não acessa; só a função "cadastros-function" lê e grava)

notify pgrst, 'reload schema';
