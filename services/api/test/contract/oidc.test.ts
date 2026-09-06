import { test, expect, beforeAll, afterAll } from "bun:test";
import { buildTestApp, type TestApp } from "../helpers/app.ts";
import { signToken, TEST_ISSUER } from "../helpers/keys.ts";
import { actor } from "../helpers/actors.ts";

/**
 * O — token från Keycloak.
 *
 * API:et är resursserver: det utfärdar ingenting och litar bara på det realmet signerat.
 * Sviten signerar med samma nyckel som appen fått insprutad, så varje fall skiljer sig
 * från det giltiga i exakt en sak.
 */
let t: TestApp;

beforeAll(async () => {
	t = await buildTestApp();
});

afterAll(async () => {
	await t.close();
});

const me = (token: string) =>
	t.app.inject({
		method: "GET",
		url: "/api/v1/me",
		headers: { authorization: `Bearer ${token}` },
	});

// ---------------------------------------------------------------- O.1

test("O.1 en giltig token från realmet släpps in", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o1@example.test",
	});
	const res = await me(token);

	expect(res.statusCode).toBe(200);
	expect(res.json<{ email: string }>().email).toBe("o1@example.test");
});

// ---------------------------------------------------------------- O.2

test("O.2 saknad, tom och trasig Authorization ger 401", async () => {
	const utan = await t.app.inject({ method: "GET", url: "/api/v1/me" });
	expect(utan.statusCode).toBe(401);

	for (const header of [
		"",
		"Bearer ",
		"Bearer inte.en.token",
		"Basic abc123",
	]) {
		const res = await t.app.inject({
			method: "GET",
			url: "/api/v1/me",
			headers: { authorization: header },
		});
		expect(res.statusCode, `huvudet "${header}"`).toBe(401);
	}
});

// ---------------------------------------------------------------- O.3

test("O.3 en manipulerad signatur ger 401", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o3@example.test",
	});
	const [header, payload] = token.split(".");
	// Samma huvud och samma påstående, men signaturen hör till någon annan token.
	const res = await me(`${header}.${payload}.${"A".repeat(342)}`);

	expect(res.statusCode).toBe(401);
});

// ---------------------------------------------------------------- O.4

test("O.4 fel issuer ger 401 — en annan realm duger inte", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o4@example.test",
		issuer: "http://angriparen.test/auth/realms/gigga",
	});

	expect((await me(token)).statusCode).toBe(401);
});

// ---------------------------------------------------------------- O.5

test("O.5 fel mottagare ger 401 — en token för en annan klient i samma realm duger inte", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o5@example.test",
		audience: "nagon-annan-tjanst",
	});

	expect((await me(token)).statusCode).toBe(401);
});

// ---------------------------------------------------------------- O.6

test("O.6 en utgången token ger 401", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o6@example.test",
		expiresIn: -60,
	});

	expect((await me(token)).statusCode).toBe(401);
});

// ---------------------------------------------------------------- O.7

test("O.7 obekräftad e-postadress ger 403, inte 401", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o7@example.test",
		emailVerified: false,
	});
	const res = await me(token);

	// Skillnaden är åtgärdbar för användaren: token duger, adressen gör det inte.
	expect(res.statusCode).toBe(403);
	expect(res.json<{ type: string }>().type).toContain("email-not-verified");
});

// ---------------------------------------------------------------- O.8

test("O.8 utan organisation ges 403 — gigga handlar mellan företag", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o8@example.test",
		organizations: [],
	});
	const res = await me(token);

	expect(res.statusCode).toBe(403);
	expect(res.json<{ type: string }>().type).toContain("organization-missing");
});

// ---------------------------------------------------------------- O.9

test("O.9 flera organisationer ger 403 istället för ett godtyckligt val", async () => {
	const token = await signToken({
		subject: crypto.randomUUID(),
		email: "o9@example.test",
		organizations: ["nordvind", "sydlig"],
	});
	const res = await me(token);

	expect(res.statusCode).toBe(403);
	expect(res.json<{ type: string }>().type).toContain("organization-ambiguous");
});

// ---------------------------------------------------------------- O.10

test("O.10 speglingen skapas en gång och står still över flera anrop", async () => {
	const subject = crypto.randomUUID();
	const token = await signToken({
		subject,
		email: "o10@example.test",
		organizations: ["o10-ab"],
	});

	const first = (await me(token)).json<{
		id: string;
		organization: { id: string };
	}>();
	const second = (await me(token)).json<{
		id: string;
		organization: { id: string };
	}>();

	expect(second.id).toBe(first.id);
	expect(second.organization.id).toBe(first.organization.id);

	const rows = (await t.sql`
    SELECT count(*)::int AS n FROM users WHERE keycloak_sub = ${subject}
  `) as { n: number }[];
	expect(rows[0]!.n).toBe(1);
});

// ---------------------------------------------------------------- O.11

test("O.11 ändrad adress och namn i Keycloak slår igenom i speglingen", async () => {
	const subject = crypto.randomUUID();

	const before = (
		await me(
			await signToken({
				subject,
				email: "gammal@example.test",
				displayName: "Gammalt",
			}),
		)
	).json<{ id: string }>();

	const after = (
		await me(
			await signToken({
				subject,
				email: "ny@example.test",
				displayName: "Nytt",
			}),
		)
	).json<{ id: string; email: string; displayName: string }>();

	// Samma rad — identiteten är `sub`, inte adressen.
	expect(after.id).toBe(before.id);
	expect(after.email).toBe("ny@example.test");
	expect(after.displayName).toBe("Nytt");
});

// ---------------------------------------------------------------- O.12

test("O.12 två konton i samma organisation delar organisationsrad", async () => {
	const [a, b] = await Promise.all([
		me(
			await signToken({
				subject: crypto.randomUUID(),
				email: "o12a@example.test",
				organizations: ["o12-ab"],
			}),
		),
		me(
			await signToken({
				subject: crypto.randomUUID(),
				email: "o12b@example.test",
				organizations: ["o12-ab"],
			}),
		),
	]);

	const first = a.json<{ organization: { id: string; alias: string } }>();
	const second = b.json<{ organization: { id: string } }>();

	expect(first.organization.alias).toBe("o12-ab");
	expect(second.organization.id).toBe(first.organization.id);
});

// ---------------------------------------------------------------- O.13

test("O.13 /me lämnar ut det lokala id:t, inte Keycloaks subjekt", async () => {
	const subject = crypto.randomUUID();
	const kim = await actor(t.app, "kim");
	const res = await me(await signToken({ subject, email: "o13@example.test" }));
	const body = res.json<{ id: string }>();

	expect(body.id).not.toBe(subject);
	// Ett riktigt users.id — samma form som ägarskapen jämförs på.
	expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
	expect(body.id).not.toBe(kim.id);
	expect(TEST_ISSUER).toContain("/realms/gigga");
});
