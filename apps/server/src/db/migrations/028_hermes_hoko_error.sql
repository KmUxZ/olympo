-- Hermes · último fallo al pedirle al operador el PDF de una guía, para poder diagnosticarlo desde la pantalla.
ALTER TABLE hermes_operators ADD COLUMN api_error text;
ALTER TABLE hermes_operators ADD COLUMN api_error_at timestamptz;
