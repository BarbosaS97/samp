-- PASSO 14: endurecimento de segurança.
-- (1) limite de tentativas persistente (força bruta no login e na senha de cadastro; protege também contra derrubada por excesso de tentativas);
-- (2) fecha de vez o acesso direto do público ao banco: tudo passa pelas Edge Functions (service role).

-- (1) contador de falhas por chave ("m:MATRICULA", "ip:ENDERECO", "adm:ENDERECO")
create table if not exists public.seguranca_tentativas (
  chave        text primary key,
  falhas       integer not null default 0,
  janela_ini   timestamptz not null default now(),
  bloqueado_ate timestamptz
);
create index if not exists seguranca_tentativas_janela on public.seguranca_tentativas (janela_ini);
alter table public.seguranca_tentativas enable row level security;
alter table public.seguranca_tentativas force row level security;
revoke all on public.seguranca_tentativas from anon, authenticated;

-- registra uma falha de forma atômica (sem corrida entre tentativas simultâneas) e devolve até quando a chave está bloqueada
create or replace function public.registrar_falha(p_chave text, p_max integer, p_janela_s integer, p_bloqueio_s integer)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare r public.seguranca_tentativas; ate timestamptz;
begin
  delete from public.seguranca_tentativas
   where janela_ini < now() - interval '1 day' and (bloqueado_ate is null or bloqueado_ate < now());
  insert into public.seguranca_tentativas as t (chave, falhas, janela_ini)
  values (p_chave, 1, now())
  on conflict (chave) do update set
    falhas     = case when t.janela_ini < now() - make_interval(secs => p_janela_s) then 1 else t.falhas + 1 end,
    janela_ini = case when t.janela_ini < now() - make_interval(secs => p_janela_s) then now() else t.janela_ini end
  returning * into r;
  if r.falhas >= p_max then
    update public.seguranca_tentativas set falhas = 0, bloqueado_ate = now() + make_interval(secs => p_bloqueio_s)
     where chave = p_chave returning bloqueado_ate into ate;
    return ate;
  end if;
  return null;
end $$;
revoke all on function public.registrar_falha(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.registrar_falha(text, integer, integer, integer) to service_role;

-- (2) nenhuma tabela do schema public fica acessível à chave pública (anon) nem a usuários autenticados
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;
revoke all on all sequences in schema public from anon, authenticated;
-- tabelas e funções criadas no futuro também nascem fechadas
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;

-- Conferência: não deve listar nenhuma linha.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');
