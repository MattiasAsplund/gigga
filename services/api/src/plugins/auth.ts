import type {
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
	onRequestHookHandler,
} from "fastify";
import { jwtVerify, type JWTPayload } from "jose";
import { upsertIdentity, type Identity } from "../db/identities.ts";
import {
	emailNotVerified,
	organizationAmbiguous,
	organizationMissing,
	unauthorized,
} from "./errors.ts";

declare module "fastify" {
	interface FastifyInstance {
		requireAuth: onRequestHookHandler;
	}
	interface FastifyRequest {
		/**
		 * Den lokala identiteten bakom token. Sätts av requireAuth och finns bara på
		 * skyddade routes — `identity.id` är `users.id`, inte Keycloaks `sub`.
		 */
		identity: Identity;
	}
}

/** Claims vi bryr oss om. Resten av tokenen är Keycloaks ensak. */
interface giggaClaims extends JWTPayload {
	email?: string;
	email_verified?: boolean;
	name?: string;
	preferred_username?: string;
	organization?: string[] | string;
}

/**
 * Organization-claimen är flervärd — Keycloaks membership-mapper skriver en lista av
 * alias, `["nordvind"]`. gigga kräver exakt ett: en användare handlar för ett företag,
 * och utan ett val i gränssnittet vore vilket som helst en gissning.
 */
function organizationOf(claims: giggaClaims): string {
	const raw = claims.organization;
	const aliases = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
		(a) => a.length > 0,
	);

	if (aliases.length === 0) throw organizationMissing();
	if (aliases.length > 1) throw organizationAmbiguous();
	return aliases[0] as string;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
	// Platsen reserveras en gång. Sätts egenskapen först i hooken får varje begäran en ny
	// form, och V8 tappar den dolda klassen den annars återanvänder.
	app.decorateRequest("identity");

	/**
	 * onRequest-hook för skyddade routes.
	 *
	 * Alla misslyckanden med själva token — saknad, utgången, manipulerad, fel issuer,
	 * fel mottagare — ger samma 401 (A2.4). Att skilja dem åt vore att berätta för den
	 * som prövar sig fram vad som var nästan rätt.
	 *
	 * `iss` kontrolleras mot den adress webbläsaren faktiskt loggade in på (config.ts),
	 * `aud` mot audience-mapparen i realmet. Utan mottagarkontrollen skulle en token
	 * utfärdad för en annan klient i samma realm duga här.
	 */
	app.decorate(
		"requireAuth",
		async (req: FastifyRequest, _reply: FastifyReply) => {
			const header = req.headers.authorization;
			const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
			if (!token)
				throw unauthorized("Token saknas, är utgången eller ogiltig.");

			let claims: giggaClaims;
			try {
				const verified = await jwtVerify<giggaClaims>(token, app.keys.resolve, {
					issuer: app.config.OIDC_ISSUER,
					audience: app.config.OIDC_AUDIENCE,
				});
				claims = verified.payload;
			} catch {
				throw unauthorized("Token saknas, är utgången eller ogiltig.");
			}

			if (!claims.sub) throw unauthorized("Token saknar subjekt.");

			/*
			 * Bekräftad adress kontrolleras trots att Keycloak redan spärrar inloggningen:
			 * required actions gäller inloggningsflödet, och en token kan ha utfärdats innan
			 * kravet slog till. Kontrollen är billig och gränsen ska hållas här.
			 */
			if (claims.email_verified !== true) throw emailNotVerified();

			const email = claims.email;
			if (!email) throw unauthorized("Token saknar e-postadress.");

			req.identity = await upsertIdentity(app.sql, {
				subject: claims.sub,
				email,
				// `name` är för- och efternamn ihop; preferred_username är reserven för konton
				// som saknar dem. Adressen sist — hellre en läsbar etikett än en tom sträng.
				displayName: claims.name ?? claims.preferred_username ?? email,
				organizationAlias: organizationOf(claims),
			});
		},
	);
}
