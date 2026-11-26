-- Hermes · operadores logísticos: las plataformas intermediarias por las que sale cada pedido
-- (cada una genera sus guías con la transportadora). La persona encargada elige el operador de cada pedido.
CREATE TABLE hermes_operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  name        text NOT NULL,
  carrier     text NOT NULL DEFAULT '',        -- transportadora con la que despacha, p. ej. Interrapidísimo
  -- 'manual': las guías se suben a mano o por archivo. Los conectores automáticos llegarán con su propio valor.
  driver      text NOT NULL DEFAULT 'manual',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hermes_operators_name_idx ON hermes_operators (company_id, lower(name));

ALTER TABLE hermes_orders ADD COLUMN operator_id uuid REFERENCES hermes_operators(id);
-- Identificador del pedido dentro del operador: cada plataforma tiene el suyo.
ALTER TABLE hermes_orders ADD COLUMN operator_ref text NOT NULL DEFAULT '';
CREATE INDEX hermes_orders_operator_idx ON hermes_orders (company_id, operator_id);
