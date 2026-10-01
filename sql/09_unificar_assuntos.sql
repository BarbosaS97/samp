-- PASSO 9: unificação de assuntos escritos de formas diferentes nas planilhas (ex.: "Lei 8.622/1993" x "LL 8.622/1993").
-- Execute ANTES de publicar a nova cadastros-function.
--
--  assuntos_equivalencias : regras confirmadas em Cadastros. "chave" é o texto do assunto sem acentos, maiúsculas
--                           e pontuação; "canonico" é o nome que deve aparecer no sistema.
--  processos.assunto_original : o assunto exatamente como veio na planilha (auditoria e reaplicação das regras).
--  (processos.assunto_principal passa a guardar o nome unificado, que é o campo que a Análise e a Sampinha já usam.)
create table if not exists public.assuntos_equivalencias (
  chave      text primary key,
  canonico   text not null,
  exemplo    text,
  criado_em  timestamptz not null default now()
);

alter table public.assuntos_equivalencias enable row level security;
alter table public.assuntos_equivalencias force row level security;
revoke all on public.assuntos_equivalencias from anon, authenticated;
-- (sem policy: só a função "cadastros-function" lê e grava)

alter table public.processos add column if not exists assunto_original text;
