-- Hermes · cuenta del operador (Hoko) para consultar el PDF de cada guía.
ALTER TABLE hermes_operators ADD COLUMN api_email    text;  -- usuario de la cuenta del operador
ALTER TABLE hermes_operators ADD COLUMN api_password text;  -- cifrada
ALTER TABLE hermes_operators ADD COLUMN api_token    text;  -- cifrado; se renueva solo cuando vence
-- Enlace del PDF que entrega el operador. Caduca, así que se guarda con su fecha y se vuelve a pedir cuando envejece.
ALTER TABLE hermes_orders ADD COLUMN guide_pdf_url text;
ALTER TABLE hermes_orders ADD COLUMN guide_pdf_at  timestamptz;
