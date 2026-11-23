-- Se retira la integración de Argos con Pancake: con un solo usuario compartido no permite distinguir vendedoras.
-- Argos queda con lo que observa la extensión (conexión, actividad, pausas y turnos).
DROP TABLE IF EXISTS argos_channel_hours;
DROP TABLE IF EXISTS argos_external_staff;
DROP TABLE IF EXISTS argos_line_connections;
