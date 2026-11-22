-- Hermes: confirmación de pedidos, envío de guías, seguimiento y novedades de entrega.

CREATE TABLE hermes_settings (
  company_id        uuid PRIMARY KEY REFERENCES core_companies(id),
  -- 'simulado': recorre todo el flujo sin enviar mensajes reales. 'pancake': envía por la API de Pancake.
  driver            text NOT NULL DEFAULT 'simulado' CHECK (driver IN ('simulado', 'pancake')),
  reminder_minutes  jsonb NOT NULL DEFAULT '[30, 180]',   -- recordatorios de confirmación, en minutos desde el mensaje anterior
  escalate_minutes  integer NOT NULL DEFAULT 360,         -- sin respuesta tras el último recordatorio → pasa a una persona
  next_number       integer NOT NULL DEFAULT 1
);

CREATE TABLE hermes_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES core_companies(id),
  code                 text NOT NULL,                      -- número visible, p. ej. H-000123
  customer_name        text NOT NULL,
  phone                text NOT NULL,                      -- solo dígitos, con indicativo de país
  address              text NOT NULL,
  city                 text NOT NULL,
  department           text NOT NULL DEFAULT '',
  notes                text NOT NULL DEFAULT '',           -- indicaciones para la entrega
  items                jsonb NOT NULL DEFAULT '[]',        -- [{name, qty, price}]
  total                integer NOT NULL DEFAULT 0,         -- valor a cobrar, en la moneda local sin decimales
  payment              text NOT NULL DEFAULT 'contraentrega' CHECK (payment IN ('contraentrega', 'pagado')),
  status               text NOT NULL DEFAULT 'por_confirmar'
                       CHECK (status IN ('por_confirmar', 'confirmado', 'despachado', 'en_reparto', 'novedad', 'entregado', 'devuelto', 'cancelado')),
  -- Qué respuesta del cliente espera el bot: confirmacion | direccion | novedad | direccion_novedad
  awaiting             text,
  -- Necesita que una persona lo atienda, y por qué.
  attention            boolean NOT NULL DEFAULT false,
  attention_reason     text NOT NULL DEFAULT '',
  seller_user_id       uuid REFERENCES core_users(id),     -- a quién se atribuye la venta
  source               text NOT NULL DEFAULT 'manual',
  external_ref         text NOT NULL DEFAULT '',
  carrier              text NOT NULL DEFAULT '',
  tracking_number      text NOT NULL DEFAULT '',
  tracking_url         text NOT NULL DEFAULT '',
  reminders_sent       integer NOT NULL DEFAULT 0,
  last_outbound_at     timestamptz,
  created_by           uuid REFERENCES core_users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  dispatched_at        timestamptz,
  out_for_delivery_at  timestamptz,
  delivered_at         timestamptz,
  returned_at          timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text NOT NULL DEFAULT '',
  UNIQUE (company_id, code)
);
CREATE INDEX hermes_orders_status_idx ON hermes_orders (company_id, status, created_at DESC);
CREATE INDEX hermes_orders_phone_idx ON hermes_orders (company_id, phone);

-- Historial de cada pedido: qué pasó, cuándo y quién (persona, bot o cliente).
CREATE TABLE hermes_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  order_id    uuid NOT NULL REFERENCES hermes_orders(id),
  at          timestamptz NOT NULL DEFAULT now(),
  type        text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  actor       text NOT NULL DEFAULT 'Hermes'
);
CREATE INDEX hermes_events_order_idx ON hermes_events (order_id, at);

-- Conversación con el cliente (entrante y saliente). order_id vacío = mensaje de un número sin pedido abierto.
CREATE TABLE hermes_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  order_id    uuid REFERENCES hermes_orders(id),
  phone       text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('out', 'in')),
  kind        text NOT NULL DEFAULT 'texto',   -- plantilla | texto | boton
  template    text NOT NULL DEFAULT '',
  body        text NOT NULL,
  buttons     jsonb NOT NULL DEFAULT '[]',     -- [{label, payload}]
  status      text NOT NULL DEFAULT 'enviado', -- simulado | enviado | fallido | recibido
  sender      text NOT NULL DEFAULT 'Hermes',  -- Hermes | nombre de la persona | Cliente
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hermes_messages_order_idx ON hermes_messages (order_id, created_at);

-- Novedades de entrega reportadas por la transportadora.
CREATE TABLE hermes_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL,
  order_id         uuid NOT NULL REFERENCES hermes_orders(id),
  type             text NOT NULL CHECK (type IN ('direccion', 'ausente', 'rehusado', 'telefono', 'zona', 'otro')),
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'esperando_cliente' CHECK (status IN ('esperando_cliente', 'por_gestionar', 'resuelta', 'devolucion')),
  customer_choice  text NOT NULL DEFAULT '',   -- reprogramar | corrige_direccion | rechaza
  resolution       text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      uuid
);
CREATE INDEX hermes_incidents_order_idx ON hermes_incidents (order_id);
