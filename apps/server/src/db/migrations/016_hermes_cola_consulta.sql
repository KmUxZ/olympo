-- Hermes: cola de envíos por WhatsApp y consulta periódica de mensajes nuevos (sin depender del webhook de Pancake).
ALTER TABLE hermes_messages ADD COLUMN delivery        jsonb;        -- cómo enviarlo: { mode: 'texto' | 'plantilla', templateId, params }
ALTER TABLE hermes_messages ADD COLUMN attempts        integer NOT NULL DEFAULT 0;
ALTER TABLE hermes_messages ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX hermes_messages_queue_idx ON hermes_messages (created_at) WHERE status = 'en_cola';

ALTER TABLE hermes_settings ADD COLUMN channel_since timestamptz;            -- desde cuándo está activo el canal: lo anterior no se procesa
ALTER TABLE hermes_settings ADD COLUMN poll_cursor   timestamptz;            -- hasta cuándo ya se consultó
ALTER TABLE hermes_settings ADD COLUMN poll_at       timestamptz;            -- última consulta
ALTER TABLE hermes_settings ADD COLUMN poll_status   text NOT NULL DEFAULT '';

ALTER TABLE hermes_orders ADD COLUMN polled_at timestamptz;                  -- última vez que se revisó su conversación (modo pedido a pedido)
