-- Hermes · qué hacer cuando el cliente no responde la confirmación tras los recordatorios:
-- 'persona' = pasa a «Por atender»; 'confirmar' = el pedido se confirma solo (los marcados con riesgo siguen yendo a una persona).
ALTER TABLE hermes_settings ADD COLUMN no_reply_action text NOT NULL DEFAULT 'persona' CHECK (no_reply_action IN ('persona', 'confirmar'));
