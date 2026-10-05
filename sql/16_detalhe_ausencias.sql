-- PASSO 16: quem pode ver o DETALHE das ausências (tipo, períodos e observações do calendário).
-- Quem não tem a permissão vê só o total de dias úteis de ausência (o detalhe nem chega ao navegador).
-- Matrículas JÁ cadastradas ficam com a permissão ligada (ajuste em Cadastros > Matrículas > Editar).
-- Matrículas cadastradas daqui em diante nascem sem a permissão (o administrador marca no cadastro).
alter table public.usuarios add column if not exists ausencias_detalhe boolean not null default true;
