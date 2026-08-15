import { buildServer } from './server.ts';

const app = await buildServer();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} mottagen, stänger ned`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: app.config.PORT, host: app.config.HOST });
} catch (err) {
  app.log.fatal({ err }, 'kunde inte starta');
  process.exit(1);
}
