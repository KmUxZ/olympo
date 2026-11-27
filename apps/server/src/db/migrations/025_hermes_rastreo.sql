-- Hermes · clave pública del pedido: al azar, va en el enlace que abre el PDF de su guía sin iniciar sesión.
ALTER TABLE hermes_orders ADD COLUMN track_token text;
CREATE UNIQUE INDEX hermes_orders_track_idx ON hermes_orders (track_token) WHERE track_token IS NOT NULL;
