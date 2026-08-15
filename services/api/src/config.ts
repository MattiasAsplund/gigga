import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const ConfigSchema = Type.Object({
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
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
