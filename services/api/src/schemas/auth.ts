import { Type } from '@sinclair/typebox';
import { UuidSchema } from './common.ts';

export const MIN_PASSWORD_LENGTH = 12;

const EmailSchema = Type.String({
  format: 'email',
  maxLength: 254,
  description: 'Normaliseras till gemener.',
  examples: ['alva@example.se'],
});

const PasswordSchema = Type.String({
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: 200,
  description: `Minst ${MIN_PASSWORD_LENGTH} tecken.`,
});

export const RegisterBodySchema = Type.Object(
  {
    email: EmailSchema,
    password: PasswordSchema,
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
  },
  { additionalProperties: false },
);

export const RegisterResponseSchema = Type.Object({
  id: UuidSchema,
  email: Type.String(),
  displayName: Type.String(),
  token: Type.String({ description: 'Access-token att skicka som Bearer.' }),
});

export const LoginBodySchema = Type.Object(
  {
    email: EmailSchema,
    // Ingen minLength här: ett kort lösenord ska ge 401, inte 422 — annars går det att
    // avgöra lösenordsregler utifrån.
    password: Type.String({ maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const LoginResponseSchema = Type.Object({
  token: Type.String(),
  expiresIn: Type.Integer({ description: 'Tokenens livslängd i sekunder.' }),
});
