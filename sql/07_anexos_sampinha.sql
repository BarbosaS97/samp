-- PASSO 7: guarda o relatório (PDF/CSV) gerado pela Sampinha junto com a mensagem do histórico,
-- para o botão "Baixar PDF" continuar funcionando ao reabrir a conversa em qualquer computador.
-- Execute depois do 06_historico_sampinha.sql e ANTES de publicar a nova sampinha-function.
alter table public.sampinha_mensagens add column if not exists anexo jsonb;
