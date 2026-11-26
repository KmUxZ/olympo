-- Hermes · nombre con el que el bot se presenta al cliente (p. ej. «Valentina»). Vacío: se presenta como el equipo de entregas.
ALTER TABLE hermes_settings ADD COLUMN bot_name text NOT NULL DEFAULT '';
