import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const ConfigSchema = Type.Object({
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  SMTP_HOST: Type.String({ default: '127.0.0.1' }),
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 1025 }),
  // Avsändarnamnet syns i mailklienten; adressens domän är en driftsfråga och byts när
  // en domän för gigga faktiskt finns på plats.
  MAIL_FROM: Type.String({ default: 'gigga <no-reply@gigga.dev>' }),
  /**
   * Webbens basadress — den användaren ser, inte API:ets. Bekräftelselänkarna pekar
   * på `/verify` där. Sätts av AppHosten.
   */
  PUBLIC_BASE_URL: Type.String({ default: '' }),
  /** Objektlagring för anbudsdokument. Sätts av AppHosten från MinIO-resursen. */
  S3_ENDPOINT: Type.String({ default: 'http://127.0.0.1:9000' }),
  S3_BUCKET: Type.String({ default: 'gigga-attachments' }),
  S3_ACCESS_KEY_ID: Type.String({ default: 'minioadmin' }),
  S3_SECRET_ACCESS_KEY: Type.String({ default: 'minioadmin' }),
  S3_REGION: Type.String({ default: 'us-east-1' }),
  /** Hur ofta föräldralösa objekt städas bort. 0 stänger av jobbet. */
  ORPHAN_SWEEP_INTERVAL_MINUTES: Type.Integer({ minimum: 0, default: 60 }),
  /** Adress som larmas när lagringen tappat innehåll. Tom stänger av larmen. */
  STORAGE_ALERT_EMAIL: Type.String({ default: '' }),
  /**
   * Realmet i Keycloak. Ingår i issuern och i JWKS-adressen.
   */
  OIDC_REALM: Type.String({ default: 'gigga', minLength: 1 }),
  /**
   * Issuern att kräva i token. Tom betyder "räkna ut den ur PUBLIC_BASE_URL" — se
   * loadConfig nedan. Anledningen till att den följer webbens adress och inte Keycloaks
   * egen är att Keycloak ligger bakom Vites /auth-proxy och bygger sin issuer ur
   * Host-huvudet: det webbläsaren såg är det som står i token.
   */
  OIDC_ISSUER: Type.String({ default: '' }),
  /**
   * Var de publika nycklarna hämtas. Tom betyder "räkna ut den ur issuern", vilket är
   * vad OIDC-discovery ändå hade svarat: nycklarna som hör till en issuer publiceras av
   * den issuern. Att hämta dem någon annanstans ifrån vore att lita på en nyckel som
   * inte kan visa att den hör ihop med det som skrev token.
   */
  OIDC_JWKS_URI: Type.String({ default: '' }),
  /** Mottagaren token ska vara utställd för. Sätts av audience-mapparen i realmet. */
  OIDC_AUDIENCE: Type.String({ default: 'gigga-api' }),
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

  /*
   * Issuern räknas ut i efterhand hellre än att sättas i AppHosten: PUBLIC_BASE_URL är
   * redan den adress användaren ser, och skrivs om till tunnelns när miljön startas med
   * --enable-cloudflare. Att härleda issuern ur den gör att båda rättas på en gång, och
   * att en felkonfiguration inte kan yttra sig som tokens som avvisas utan förklaring.
   *
   * Reservvärdet är webbens standardport, inte API:ets: det är webbens origin Keycloak
   * ligger under, även när tjänsterna körs för hand vid sidan av Aspire.
   */
  if (!raw.OIDC_ISSUER) {
    const base = raw.PUBLIC_BASE_URL || 'http://localhost:5173';
    raw.OIDC_ISSUER = `${base.replace(/\/+$/, '')}/auth/realms/${raw.OIDC_REALM}`;
  }

  if (!raw.OIDC_JWKS_URI) {
    raw.OIDC_JWKS_URI = `${raw.OIDC_ISSUER}/protocol/openid-connect/certs`;
  }

  return raw;
}
