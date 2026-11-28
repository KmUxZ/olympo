-- Hermes · si el pedido espera la respuesta del cliente para quedar confirmado.
--   obligatoria: espera la respuesta (como siempre) · informativa: se le escribe pero ya nace confirmado · ninguna: no se le escribe.
ALTER TABLE hermes_settings ADD COLUMN confirmation_mode text NOT NULL DEFAULT 'obligatoria' CHECK (confirmation_mode IN ('obligatoria', 'informativa', 'ninguna'));
