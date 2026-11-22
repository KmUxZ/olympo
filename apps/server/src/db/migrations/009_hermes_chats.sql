-- Bandeja de chats de Hermes: quién tiene la conversación, desde cuándo se espera y qué falta por leer.
ALTER TABLE hermes_orders ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;   -- una persona tomó la conversación
ALTER TABLE hermes_orders ADD COLUMN taken_by text NOT NULL DEFAULT '';
ALTER TABLE hermes_orders ADD COLUMN attention_at timestamptz;                    -- desde cuándo espera a una persona
ALTER TABLE hermes_orders ADD COLUMN last_inbound_at timestamptz;                 -- último mensaje del cliente
ALTER TABLE hermes_orders ADD COLUMN seen_at timestamptz;                         -- última vez que alguien del equipo abrió el chat
