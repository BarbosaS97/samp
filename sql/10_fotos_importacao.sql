-- PASSO 10: fotos (resumos) gravadas a cada importação da planilha, para formar o histórico real de acervo,
-- entradas e saídas por assunto. Execute ANTES de publicar a nova cadastros-function.
--
--  processos_fotos           : uma linha por importação (data, total, entradas e saídas totais)
--  processos_fotos_assuntos  : uma linha por assunto em cada importação (acervo, entradas, saídas e faixas de idade)
--
-- Entrada = número de processo que aparece na importação nova e não estava na anterior.
-- Saída   = número que estava na importação anterior e não está mais na nova (saiu da fila da planilha).
-- Na primeira importação não há como calcular entradas e saídas (ficam nulas).
create table if not exists public.processos_fotos (
  id         bigint generated always as identity primary key,
  data_foto  timestamptz not null,
  total      integer not null,
  entradas   integer,
  saidas     integer,
  origem     text not null default 'importacao'
);

create table if not exists public.processos_fotos_assuntos (
  foto_id    bigint not null references public.processos_fotos(id) on delete cascade,
  assunto    text not null,
  qtd        integer not null,
  entradas   integer,
  saidas     integer,
  f0_30      integer not null default 0,
  f31_60     integer not null default 0,
  f61_90     integer not null default 0,
  f91_120    integer not null default 0,
  f121_180   integer not null default 0,
  f181_365   integer not null default 0,
  f366_mais  integer not null default 0,
  soma_dias  bigint  not null default 0,
  primary key (foto_id, assunto)
);
create index if not exists idx_fotos_assuntos_assunto on public.processos_fotos_assuntos (assunto, foto_id);

alter table public.processos_fotos enable row level security;
alter table public.processos_fotos force row level security;
alter table public.processos_fotos_assuntos enable row level security;
alter table public.processos_fotos_assuntos force row level security;
revoke all on public.processos_fotos from anon, authenticated;
revoke all on public.processos_fotos_assuntos from anon, authenticated;
-- (sem policy: o público não acessa; só as funções do servidor leem e gravam)

notify pgrst, 'reload schema';
