import { exportJWK, SignJWT, type JSONWebKeySet, type JWK } from "jose";

/**
 * Testernas motsvarighet till Keycloaks realm.
 *
 * Sviten signerar sina egna tokens med en RS256-nyckel den slår fram vid start, och
 * API:et verifierar dem mot samma nyckeluppsättning genom `createLocalKeys`. Ingen
 * Keycloak, ingen port, inget nät — `bun test` behåller sin karaktär (planen §7.1).
 *
 * Nyckeln är gemensam för hela körningen: `generateKey` med 2048 bitar kostar tiondelar
 * av en sekund, och att göra om det per testfil vore den dyraste raden i sviten.
 */
export const TEST_ISSUER = "http://gigga.test/auth/realms/gigga";
export const TEST_AUDIENCE = "gigga-api";
const KID = "test-signing-key";

interface TestKeys {
	jwks: JSONWebKeySet;
	privateKey: CryptoKey;
}

let keysPromise: Promise<TestKeys> | null = null;

function generate(): Promise<TestKeys> {
	return (async () => {
		const pair = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);

		const publicJwk = (await exportJWK(pair.publicKey)) as JWK;
		return {
			jwks: { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] },
			privateKey: pair.privateKey,
		};
	})();
}

export function testKeys(): Promise<TestKeys> {
	keysPromise ??= generate();
	return keysPromise;
}

export interface TokenClaims {
	subject: string;
	email: string;
	displayName?: string;
	/** Alias, precis som Keycloaks membership-mapper skriver dem. Flera ger 403. */
	organizations?: string[];
	emailVerified?: boolean;
	issuer?: string;
	audience?: string;
	/** Sekunder från nu. Negativt ger en utgången token. */
	expiresIn?: number;
}

/**
 * Skriver en token som ser ut precis som Keycloaks — samma claims, samma former.
 * Avvikelserna är parametrar, så ett testfall kan be om just den token som ska avvisas.
 */
export async function signToken(claims: TokenClaims): Promise<string> {
	const { privateKey } = await testKeys();
	const now = Math.floor(Date.now() / 1000);
	const expiresIn = claims.expiresIn ?? 3600;

	return await new SignJWT({
		email: claims.email,
		email_verified: claims.emailVerified ?? true,
		name: claims.displayName ?? claims.email,
		// Flervärd som i realmet, även när det bara är en.
		organization: claims.organizations ?? ["nordvind"],
		azp: "gigga-web",
	})
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setSubject(claims.subject)
		.setIssuer(claims.issuer ?? TEST_ISSUER)
		.setAudience(claims.audience ?? TEST_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + expiresIn)
		.sign(privateKey);
}
