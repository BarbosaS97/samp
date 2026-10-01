-- PASSO 3: execute SOMENTE depois de publicar a função "cadastros-function" e testar o bloco Cadastros.
-- Torna as 4 tabelas SOMENTE LEITURA para o público (chave anon e usuários autenticados).
-- Toda escrita passa a exigir a SENHA_CADASTRO (a Edge Function usa a service role, que ignora RLS e GRANTs de anon).
-- Duas camadas independentes: (1) RLS só com política de leitura; (2) privilégios de escrita revogados.
do $$
declare t text; pol record;
begin
  foreach t in array array['processos','configuracoes','config_periodos','dados_processos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    for pol in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('create policy "leitura_publica" on public.%I for select to anon, authenticated using (true)', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

-- Impede que o público consuma as sequências (IDs) das tabelas.
revoke usage, update on all sequences in schema public from anon, authenticated;

-- Conferência: deve listar somente "SELECT" para anon em cada tabela.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privilegios
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('processos','configuracoes','config_periodos','dados_processos')
  and grantee in ('anon','authenticated')
group by table_name, grantee
order by table_name, grantee;
