import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';

/**
 * Var de publika nycklarna kommer ifrån.
 *
 * Samma söm som `Mailer` och `ObjectStore`: drift går till Keycloak, testerna skickar in
 * en egen nyckeluppsättning. Det är det som håller `bun test` offline och portlöst —
 * sviten signerar sina egna tokens med en nyckel den själv slagit fram, och API:et
 * verifierar dem utan att veta att Keycloak inte finns.
 */
export interface KeySource {
  resolve: JWTVerifyGetKey;
}

/**
 * Realmets JWKS över nätet. `createRemoteJWKSet` hämtar lat — inte vid uppstart utan vid
 * första token som ska verifieras — och cachar enligt svarets Cache-Control. Nyckelbyten
 * hämtas alltså in av sig själva.
 *
 * Uppsättningen bär mer än en nyckel: realmet har både en RS256-nyckel för signaturer och
 * en RSA-OAEP-nyckel för kryptering. Valet sker på `kid` och `use`, vilket jose gör åt oss.
 */
export function createRemoteKeys(jwksUri: string): KeySource {
  return { resolve: createRemoteJWKSet(new URL(jwksUri)) };
}

/** En nyckeluppsättning som redan finns i minnet. Testernas motsvarighet till realmet. */
export function createLocalKeys(jwks: JSONWebKeySet): KeySource {
  return { resolve: createLocalJWKSet(jwks) };
}
