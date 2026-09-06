import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * API:et nås genom Vites proxy under /api. Det gör att webben och API:et delar origin,
 * vilket i sin tur gör att ingen CORS-konfiguration behövs i backenden — och att
 * Playwright bara behöver känna till en adress.
 */
export default defineConfig({
	plugins: [react()],
	server: {
		host: "0.0.0.0",
		// E2E-sviten kör i en container och når värden under det här namnet. Vite svarar
		// annars "Blocked request" på allt utom localhost, och sidan blir tom i stället
		// för att felet syns.
		allowedHosts: [
			".trycloudflare.com",
			"aspire.dev.internal",
			"host.containers.internal",
			"host.docker.internal",
		],
		port: Number(process.env.PORT ?? 5173),
		strictPort: true,
		proxy: {
			/*
			 * Keycloak under /auth på webbens egen origin. Det är inte kosmetika: Keycloak
			 * bygger sin issuer ur Host-huvudet, så när inloggningen går den här vägen blir
			 * tokenens `iss` webbens adress — samma på localhost, från e2e-containern och
			 * bakom en cloudflare-tunnel, utan konfiguration per miljö.
			 *
			 * changeOrigin: false, till skillnad från /api nedan. Skrivs Host om till
			 * containerns adress bygger Keycloak issuern ur *den*, och webbläsaren skickas
			 * till en adress den inte når. Här ska ursprunget passera orört.
			 */
			"/auth": {
				target: process.env.KEYCLOAK_TARGET ?? "https://localhost:8080",
				changeOrigin: false,
				xfwd: true,
				// Aspire ställer Keycloak bakom sitt eget utvecklingscertifikat. Det är inte
				// utfärdat av något proxyn litar på, och ska inte vara det heller — trafiken
				// går till localhost.
				secure: false,
			},
			"/api": {
				// API_TARGET sätts av AppHosten och bär API:ets lottade port. Reservvärdet
				// gäller bara när Vite körs för hand, vid sidan av Aspire — då står API:et på
				// sin egen standardport (services/api/src/config.ts).
				target: process.env.API_TARGET ?? "http://localhost:3000",
				changeOrigin: true,
				// Utan detta ser varje besökare ut att komma från proxyn, och API:ets kvotgräns
				// per anropare skulle bli ett gemensamt tak för hela webben.
				xfwd: true,
			},
		},
	},
});
