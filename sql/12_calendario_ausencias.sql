-- PASSO 12: calendário de ausências da Produção Individual (planilha "CALENDÁRIO SECAJ").
-- Execute ANTES de publicar a nova cadastros-function.
--
--  producao_calendario : uma linha por pessoa (o mesmo nome usado na produção) com, para cada mês, os dias úteis e os
--                        dias úteis de férias, licença, treinamento/licença, falta e recesso, mais os períodos e as
--                        observações (sem detalhes de saúde). Cada importação do calendário substitui tudo.
--  producao_apelidos   : como cada nome do calendário corresponde a uma pessoa da produção (ex.: "Thiago Alves" ->
--                        "Thiago Borges"). Fica salvo para as próximas importações.
create table if not exists public.producao_calendario (
  pessoa        text primary key,
  dados         jsonb       not null,
  arquivo       text,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.producao_apelidos (
  chave  text primary key,   -- nome no calendário, sem acento e em minúsculas
  nome   text not null,      -- nome como aparece no calendário
  pessoa text                -- pessoa da produção; vazio = ignorar esse nome
);

alter table public.producao_calendario enable row level security;
alter table public.producao_calendario force row level security;
alter table public.producao_apelidos   enable row level security;
alter table public.producao_apelidos   force row level security;
revoke all on public.producao_calendario from anon, authenticated;
revoke all on public.producao_apelidos   from anon, authenticated;
-- (sem policy: o público não acessa; só a função "cadastros-function" lê e grava)

notify pgrst, 'reload schema';
