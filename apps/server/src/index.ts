import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { config } from './config.ts';
import { db } from './db/db.ts';
import { HttpError } from './core/http.ts';
import { authRoutes } from './core/auth.routes.ts';
import { adminRoutes } from './core/admin.routes.ts';
import { platformRoutes } from './core/platform.routes.ts';
import { catalogRoutes } from './argos/catalog.routes.ts';
import { shiftRoutes } from './argos/shifts.routes.ts';
import { dashboardRoutes } from './argos/dashboard.routes.ts';
import { incidentRoutes } from './argos/incidents.routes.ts';
import { alarmRoutes } from './argos/alarms.ts';
import { reportRoutes } from './argos/reports.routes.ts';
import { agendaRoutes } from './argos/agenda.routes.ts';
import { messageRoutes } from './argos/messages.routes.ts';
import { coachingRoutes } from './argos/coaching.routes.ts';
import { qualityRoutes } from './argos/quality.routes.ts';
import { notificationRoutes } from './argos/notifications.routes.ts';
import { rosterRoutes } from './argos/roster.ts';
import { extensionRoutes } from './argos/extension.routes.ts';
import { hermesRoutes } from './hermes/routes.ts';
import { athenaRoutes } from './athena/routes.ts';
import { startJobs } from './argos/jobs.ts';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1_048_576 });
await app.register(cookie);

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'solicitud_invalida', message: 'Solicitud no válida.' } });
  req.log.error(err);
  return reply.status(500).send({ error: { code: 'error_interno', message: 'Ocurrió un error inesperado. Inténtalo de nuevo.' } });
});

app.get('/api/health', async () => ({ ok: true, serverTime: new Date(), db: db.kind }));

// Plataforma compartida (core) y módulos de producto. Zeus, Athena y Hermes se registrarán aquí como módulos hermanos.
authRoutes(app);
adminRoutes(app);
platformRoutes(app);
catalogRoutes(app);
shiftRoutes(app);
dashboardRoutes(app);
incidentRoutes(app);
alarmRoutes(app);
reportRoutes(app);
agendaRoutes(app);
messageRoutes(app);
coachingRoutes(app);
qualityRoutes(app);
notificationRoutes(app);
extensionRoutes(app);
rosterRoutes(app);
hermesRoutes(app);
athenaRoutes(app);

// En producción el servidor entrega también la plataforma web ya compilada.
if (existsSync(config.webDist)) {
  const { default: fastifyStatic } = await import('@fastify/static');
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'no_encontrado', message: 'Ruta no encontrada.' } });
    return reply.sendFile('index.html');
  });
}

const stopJobs = startJobs(app.log);
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopJobs();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
