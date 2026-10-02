-- PASSO 13: senha de acesso ao SAMP.
-- Guarda apenas o hash (PBKDF2-SHA256 com sal individual), nunca a senha. Fica nulo até a pessoa escolher a senha no primeiro acesso.
-- A tabela continua fechada ao público: só a função "cadastros-function" (service role) lê e grava.
alter table public.usuarios add column if not exists senha_hash text;
alter table public.usuarios add column if not exists senha_definida_em timestamptz;
