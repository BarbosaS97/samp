-- PASSO 15: quais produções individuais cada matrícula pode ver em detalhe (visão "Individual").
-- A visão do Setor continua igual para todos. Quem é marcado "producao_todas" vê todas as pessoas, inclusive as importadas depois.
-- Matrículas JÁ cadastradas ficam com "todas" (nada muda até o administrador ajustar em Cadastros > Matrículas).
-- Matrículas cadastradas daqui em diante nascem sem nenhuma (o administrador escolhe no cadastro).
alter table public.usuarios add column if not exists producao_todas boolean not null default true;

create table if not exists public.usuarios_producao (
  matricula text not null references public.usuarios (matricula) on delete cascade on update cascade,
  pessoa    text not null,
  primary key (matricula, pessoa)
);
alter table public.usuarios_producao enable row level security;
alter table public.usuarios_producao force row level security;
revoke all on public.usuarios_producao from anon, authenticated;
