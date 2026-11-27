-- Hermes · archivo de carga masiva para el operador: valores fijos de la plantilla y qué pedidos ya se descargaron.
ALTER TABLE hermes_operators ADD COLUMN export_config jsonb;
ALTER TABLE hermes_orders ADD COLUMN exported_at timestamptz;
