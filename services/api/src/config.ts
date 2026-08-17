import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const ConfigSchema = Type.Object({
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  SMTP_HOST: Type.String({ default: '127.0.0.1' }),
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 1025 }),
  MAIL_FROM: Type.String({ default: 'fastgig <no-reply@fastgig.dev>' }),
  /**
   * Webbens basadress — den användaren ser, inte API:ets. Bekräftelselänkarna pekar
   * på `/verify` där. Sätts av AppHosten.
   */
  PUBLIC_BASE_URL: Type.String({ default: '' }),
  /**
   * Sida där användaren sätter nytt lösenord. Tom betyder att återställningsmailet
   * bär koden i klartext istället för en länk — se mail/password-reset-email.ts.
   */
  PASSWORD_RESET_URL: Type.String({ default: '' }),
  /** Objektlagring för anbudsdokument. Sätts av AppHosten från MinIO-resursen. */
  S3_ENDPOINT: Type.String({ default: 'http://127.0.0.1:9000' }),
  S3_BUCKET: Type.String({ default: 'fastgig-attachments' }),
  S3_ACCESS_KEY_ID: Type.String({ default: 'minioadmin' }),
  S3_SECRET_ACCESS_KEY: Type.String({ default: 'minioadmin' }),
  S3_REGION: Type.String({ default: 'us-east-1' }),
  /** Hur ofta föräldralösa objekt städas bort. 0 stänger av jobbet. */
  ORPHAN_SWEEP_INTERVAL_MINUTES: Type.Integer({ minimum: 0, default: 60 }),
  /** Adress som larmas när lagringen tappat innehåll. Tom stänger av larmen. */
  STORAGE_ALERT_EMAIL: Type.String({ default: '' }),
  JWT_SECRET: Type.String({ minLength: 32 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
});

export type Config = typeof ConfigSchema.static;

/**
 * Läser och validerar miljön. Kastar med en läsbar lista av fel — ett API som startar
 * halvkonfigurerat är värre än ett som vägrar starta.
 */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const raw = Value.Convert(ConfigSchema, Value.Default(ConfigSchema, { ...env }));

  if (!Value.Check(ConfigSchema, raw)) {
    const problems = [...Value.Errors(ConfigSchema, raw)]
      .map((e) => `  ${e.path.replace(/^\//, '') || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Ogiltig konfiguration:\n${problems}`);
  }

  return raw;
}
