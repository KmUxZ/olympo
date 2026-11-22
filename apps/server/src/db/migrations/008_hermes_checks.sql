-- Resultado del validador de datos de entrega y nivel de riesgo del cliente al crear el pedido.
ALTER TABLE hermes_orders ADD COLUMN address_check jsonb;
ALTER TABLE hermes_orders ADD COLUMN customer_risk text NOT NULL DEFAULT 'nuevo';
