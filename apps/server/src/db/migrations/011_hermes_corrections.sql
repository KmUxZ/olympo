-- Correcciones pedidas a la vendedora: logística señala un dato errado y quien subió el pedido lo corrige.
ALTER TABLE hermes_orders ADD COLUMN correction_note text NOT NULL DEFAULT '';
ALTER TABLE hermes_orders ADD COLUMN correction_requested_at timestamptz;
ALTER TABLE hermes_orders ADD COLUMN correction_by text NOT NULL DEFAULT '';
ALTER TABLE hermes_orders ADD COLUMN corrected_at timestamptz;
