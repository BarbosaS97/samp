-- PASSO 5: execute SOMENTE depois de publicar a nova função, cadastrar sua matrícula em
-- Cadastros > Usuários e confirmar que o login por matrícula funciona.
-- Fecha a leitura das 4 tabelas para o público: os dados só saem pela função, após validar a matrícula.
-- (Substitui o 03_travar_escrita.sql, que ainda permitia leitura pública.)
do $$
declare t text; pol record;
begin
  foreach t in array array['processos','configuracoes','config_periodos','dados_processos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke usage, update on all sequences in schema public from anon, authenticated;

-- Conferência: não deve listar nenhuma linha para anon/authenticated.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('processos','configuracoes','config_periodos','dados_processos','usuarios')
  and grantee in ('anon','authenticated');
