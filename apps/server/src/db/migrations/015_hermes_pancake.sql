-- Hermes: canal real de WhatsApp a través de Pancake.
ALTER TABLE hermes_settings ADD COLUMN pancake_page_id text NOT NULL DEFAULT '';
ALTER TABLE hermes_settings ADD COLUMN pancake_token   text;                         -- token de página, cifrado
ALTER TABLE hermes_settings ADD COLUMN webhook_key     text;                         -- parte secreta de la dirección donde Pancake avisa de los mensajes
ALTER TABLE hermes_settings ADD COLUMN templates       jsonb NOT NULL DEFAULT '{}';  -- { hermes_confirmacion: "<id de la plantilla aprobada>", … }
CREATE UNIQUE INDEX hermes_settings_webhook_idx ON hermes_settings (webhook_key) WHERE webhook_key IS NOT NULL;

ALTER TABLE hermes_messages ADD COLUMN external_id text;                 -- identificador del mensaje en Pancake
ALTER TABLE hermes_messages ADD COLUMN error       text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX hermes_messages_external_idx ON hermes_messages (company_id, external_id) WHERE external_id IS NOT NULL;
