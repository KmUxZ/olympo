-- Hermes · conector de Hoko: el operador avisa cada cambio de una guía a una dirección secreta.
ALTER TABLE hermes_operators ADD COLUMN webhook_key text;          -- parte secreta de la dirección de avisos
ALTER TABLE hermes_operators ADD COLUMN last_event_at timestamptz; -- último aviso recibido
CREATE UNIQUE INDEX hermes_operators_webhook_idx ON hermes_operators (webhook_key) WHERE webhook_key IS NOT NULL;

-- Último estado de la guía que informó el operador, para no repetir avisos al cliente.
ALTER TABLE hermes_orders ADD COLUMN operator_state text NOT NULL DEFAULT '';
CREATE INDEX hermes_orders_operator_ref_idx ON hermes_orders (operator_id, operator_ref) WHERE operator_ref <> '';

-- Registro de los avisos recibidos: sirve para ver cuáles no encontraron pedido y por qué.
CREATE TABLE hermes_operator_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  operator_id   uuid NOT NULL REFERENCES hermes_operators(id),
  at            timestamptz NOT NULL DEFAULT now(),
  external_ref  text NOT NULL DEFAULT '',   -- número del pedido en el operador
  guide_number  text NOT NULL DEFAULT '',
  state         text NOT NULL DEFAULT '',
  state_name    text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  order_id      uuid REFERENCES hermes_orders(id),
  result        text NOT NULL DEFAULT ''    -- qué se hizo, o por qué no se hizo nada
);
CREATE INDEX hermes_operator_events_idx ON hermes_operator_events (company_id, operator_id, at DESC);
