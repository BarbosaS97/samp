-- PASSO 6: histórico de conversas da Sampinha, guardado no banco por matrícula
-- (acessível de qualquer computador). Execute depois do 04_usuarios.sql.
--
-- As tabelas ficam fechadas para o público: só a função "sampinha-function" (service role) lê e grava,
-- e ela sempre filtra pela matrícula da sessão, então cada pessoa só enxerga as próprias conversas.
-- ATENÇÃO: o histórico é apagado junto se a matrícula for EXCLUÍDA em Cadastros (on delete cascade).
-- Para manter o histórico, use "Bloquear" em vez de "Excluir".

create table if not exists public.sampinha_conversas (
  id            uuid primary key default gen_random_uuid(),
  matricula     text not null references public.usuarios(matricula) on delete cascade on update cascade,
  titulo        text not null,
  criada_em     timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);
create index if not exists idx_sampinha_conv_matricula on public.sampinha_conversas (matricula, atualizada_em desc);

create table if not exists public.sampinha_mensagens (
  id          bigint generated always as identity primary key,
  conversa_id uuid not null references public.sampinha_conversas(id) on delete cascade,
  matricula   text not null,
  role        text not null check (role in ('user', 'assistant')),
  conteudo    text not null,
  criada_em   timestamptz not null default now()
);
create index if not exists idx_sampinha_msg_conversa  on public.sampinha_mensagens (conversa_id, id);
create index if not exists idx_sampinha_msg_matricula on public.sampinha_mensagens (matricula);

alter table public.sampinha_conversas enable row level security;
alter table public.sampinha_conversas force row level security;
alter table public.sampinha_mensagens enable row level security;
alter table public.sampinha_mensagens force row level security;
revoke all on public.sampinha_conversas from anon, authenticated;
revoke all on public.sampinha_mensagens from anon, authenticated;
-- (sem nenhuma policy: o público não enxerga nem altera nada nestas tabelas)

-- Conferência: não deve listar nenhuma linha.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('sampinha_conversas', 'sampinha_mensagens')
  and grantee in ('anon', 'authenticated');
