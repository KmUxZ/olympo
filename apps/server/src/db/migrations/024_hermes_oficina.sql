-- Hermes · paquete esperando en una oficina de la transportadora: desde cuándo y cuántos recordatorios se le han enviado al cliente.
ALTER TABLE hermes_orders ADD COLUMN office_at timestamptz;
ALTER TABLE hermes_orders ADD COLUMN office_reminders integer NOT NULL DEFAULT 0;
