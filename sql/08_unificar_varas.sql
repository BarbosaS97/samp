-- PASSO 8: unificação das varas pela numeração (1 a 22 = Varas Comuns, 23 a 27 = JEF; adjuntos tratados à parte).
-- Execute ANTES de publicar a nova cadastros-function.
--
--  orgao_julgador : passa a guardar o nome unificado da vara (é o campo que a Análise e a Sampinha já usam)
--  orgao_original : texto exatamente como veio na planilha (auditoria)
--  vara_num       : número da vara (1 a 27)
--  vara_tipo      : tipo da unidade: 'comum' ou 'jef' (num adjunto, é o inverso do tipo da vara)
--  adjunto        : true quando a unidade é adjunta da vara
alter table public.processos
  add column if not exists orgao_original text,
  add column if not exists vara_num       smallint,
  add column if not exists vara_tipo      text check (vara_tipo in ('comum', 'jef')),
  add column if not exists adjunto        boolean not null default false;

create index if not exists idx_processos_vara_num on public.processos (vara_num);

-- Depois de publicar a função, use em Cadastros > Processos o botão
-- "Reaplicar unificação na base atual" (ou importe a planilha novamente).
