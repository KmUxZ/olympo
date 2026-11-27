-- Hermes · enlace público de rastreo: cada pedido despachado tiene una clave al azar que abre su página de seguimiento sin iniciar sesión.
ALTER TABLE hermes_orders ADD COLUMN track_token text;
CREATE UNIQUE INDEX hermes_orders_track_idx ON hermes_orders (track_token) WHERE track_token IS NOT NULL;
