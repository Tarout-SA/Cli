import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { normalizeApiUrl } from "./api-url.js";
import { platformFetch } from "./password-gate.js";

export interface AuthCallbackData {
	token: string;
	userId: string;
	userEmail: string;
	userName?: string;
	organizationId: string;
	organizationName: string;
	projectId: string;
	projectName: string;
	projectSlug?: string;
	/** Compatibility hints from older platform releases; not auth scopes. */
	environmentId?: string;
	environmentName?: string;
}

export type ExchangeAuthorizationCode = (
	code: string,
	codeVerifier: string,
) => Promise<AuthCallbackData>;

export interface StartAuthServerOptions {
	state?: string;
	codeVerifier?: string;
	exchangeCode: ExchangeAuthorizationCode;
	timeoutMs?: number;
}

export interface StartCliBrowserAuthOptions
	extends Omit<StartAuthServerOptions, "exchangeCode"> {
	action?: "login" | "register";
	exchangeCode?: ExchangeAuthorizationCode;
}

function createAuthState(): string {
	return randomBytes(32).toString("base64url");
}

export function createPkceVerifier(): string {
	return randomBytes(32).toString("base64url");
}

export function createPkceChallenge(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

function parseAuthCallbackData(value: unknown): AuthCallbackData {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			"Tarout returned an invalid response to the authorization-code exchange.",
		);
	}

	const record = value as Record<string, unknown>;
	const required = [
		"token",
		"userId",
		"userEmail",
		"organizationId",
		"organizationName",
		"projectId",
		"projectName",
	] as const;
	const optional = [
		"userName",
		"projectSlug",
		"environmentId",
		"environmentName",
	] as const;
	const valid =
		required.every(
			(key) => typeof record[key] === "string" && record[key].length > 0,
		) &&
		optional.every(
			(key) => record[key] === undefined || typeof record[key] === "string",
		);
	if (!valid) {
		throw new Error(
			"Tarout returned an invalid response to the authorization-code exchange.",
		);
	}

	return record as unknown as AuthCallbackData;
}

export async function exchangeCliAuthorizationCode(
	apiUrl: string,
	code: string,
	codeVerifier: string,
	options: { timeoutMs?: number } = {},
): Promise<AuthCallbackData> {
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(code) ||
		!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
	) {
		throw new Error("Invalid authorization request.");
	}
	const normalizedApiUrl = normalizeApiUrl(apiUrl);
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 15_000,
	);
	timeout.unref?.();

	try {
		const endpoint = `${normalizedApiUrl}/api/cli/exchange`;
		const response = await platformFetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, codeVerifier }),
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`Tarout rejected the authorization-code exchange (HTTP ${response.status}).`,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error(
				"Tarout returned an invalid response to the authorization-code exchange.",
			);
		}
		return parseAuthCallbackData(body);
	} finally {
		clearTimeout(timeout);
	}
}

export async function startCliBrowserAuth(
	apiUrl: string,
	options: StartCliBrowserAuthOptions = {},
): Promise<
	Awaited<ReturnType<typeof startAuthServer>> & {
		authUrl: string;
		callbackUrl: string;
	}
> {
	const normalizedApiUrl = normalizeApiUrl(apiUrl);
	const authServer = await startAuthServer({
		state: options.state,
		codeVerifier: options.codeVerifier,
		timeoutMs: options.timeoutMs,
		exchangeCode:
			options.exchangeCode ??
			((code, codeVerifier) =>
				exchangeCliAuthorizationCode(normalizedApiUrl, code, codeVerifier)),
	});
	const callbackUrl = new URL(
		`http://127.0.0.1:${authServer.port}/callback`,
	);
	callbackUrl.searchParams.set("state", authServer.state);
	callbackUrl.searchParams.set("protocol", "2");
	callbackUrl.searchParams.set("code_challenge", authServer.codeChallenge);
	callbackUrl.searchParams.set("code_challenge_method", "S256");

	const authUrl = new URL(`${normalizedApiUrl}/cli-authorize`);
	if (options.action === "register") {
		authUrl.searchParams.set("action", "register");
	}
	authUrl.searchParams.set("callback", callbackUrl.toString());

	return {
		...authServer,
		authUrl: authUrl.toString(),
		callbackUrl: callbackUrl.toString(),
	};
}

function safeEqual(a: string, b: string): boolean {
	const aBuffer = Buffer.from(a);
	const bBuffer = Buffer.from(b);
	if (aBuffer.length !== bBuffer.length) return false;
	return timingSafeEqual(aBuffer, bBuffer);
}

function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// The white Tarout wordmark (public/logo-white.svg), inlined so the callback
// page stays fully self-contained on 127.0.0.1 with no network requests. `fill`
// inherits to the paths; we drive it with `currentColor`.
const TAROUT_WORDMARK = `<svg class="wordmark" viewBox="0 0 1015 297" fill="currentColor" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tarout"><path d="M332.36 0H264.74C258.45 0 253.28 5.17999 253.28 11.46V30.92C253.28 34.72 250.2 37.8 246.4 37.8H225.77C221.98 37.8 218.9 34.72 218.9 30.92V11.46C218.9 5.17999 213.72 0 207.44 0H136.38C130.09 0 124.92 5.17999 124.92 11.46V30.92C124.92 34.72 121.84 37.8 118.04 37.8H97.49C93.69 37.8 90.61 34.72 90.61 30.92V11.46C90.61 5.17999 85.44 0 79.15 0H11.46C5.18002 0 0 5.17999 0 11.46V111.54C0 118.52 5.23 124.39 12.16 125.2L95.58 134.96C102.51 135.77 107.73 141.62 107.73 148.6V281.95C107.73 285.75 110.81 288.81 114.61 288.81H229.21C233.01 288.81 236.09 285.75 236.09 281.95V145.55C236.09 138.41 241.56 132.48 248.67 131.87L278.99 129.29L277.11 118.71L280.5 116.13C288.42 110.08 298.33 105.14 309.96 101.44C320.69 97.91 332.07 95.99 343.82 95.74V11.46C343.82 5.17999 338.64 0 332.36 0ZM194.83 206.29H148.99V136.38C148.99 123.81 159.33 113.46 171.91 113.46C184.49 113.46 194.83 123.81 194.83 136.38V206.29Z"/><path d="M931.03 271.48V271.52L931.06 271.56C934.61 278.8 940.19 284.68 947.65 289.2C955.32 293.86 965.27 296.04 977.19 296.04H1010.52L1010.82 292.88L1013.43 266.08L1013.8 262.24H1001.38C989.4 262.24 981.02 261.55 976 260.3C973.83 259.74 972.24 258.85 971.08 257.71C969.92 256.57 969.03 255.03 968.48 252.95C967.24 248.21 966.55 240.15 966.55 228.53V136H1014.56V102.95H966.55V54.2L962.7 54.58L929.2 57.9299L926.05 58.25V102.95H898.14L897.78 106.05L894.81 132.1L894.36 136H926.05V249C926.05 256.83 927.71 264.34 931.03 271.5V271.48Z"/><path d="M761.26 287H761.28V287.02C771.98 293.09 784.76 296.04 799.5 296.04C814.24 296.04 826.19 293.23 835.6 287.31H835.61C840.11 284.45 844.24 280.93 848.02 276.75L850.4 289.46L850.93 292.32H887.11V102.93H846.62V241.37C845.5 243.07 844.28 244.64 842.93 246.07L842.17 245.56L842.37 246.65C840.2 248.85 837.74 250.72 835 252.26C826.73 256.92 817.77 259.25 808.06 259.25C793.92 259.25 784.32 254.52 778.42 245.58C772.37 236.22 769.13 222.24 769.13 203.2V102.93H728.63V212.51C728.63 231.05 731.27 246.59 736.74 258.96H736.75V258.99C742.36 271.36 750.51 280.76 761.26 287Z"/><path d="M573.06 282.83H573.08V282.85C587.27 291.7 604.26 296.04 623.89 296.04C643.52 296.04 660.32 291.7 674.5 282.85H674.52C688.58 273.94 699.32 262.04 706.67 247.2C714.13 232.28 717.84 215.73 717.84 197.63C717.84 179.53 714.14 163.04 706.67 148.24C699.32 133.28 688.58 121.38 674.51 112.6C660.33 103.63 643.41 99.22 623.89 99.22C604.37 99.22 587.26 103.62 573.08 112.6C559.13 121.38 548.4 133.28 540.92 148.24C533.58 163.05 529.94 179.54 529.94 197.63C529.94 215.72 533.58 232.27 540.91 247.19V247.21L540.93 247.23C548.4 262.06 559.13 273.94 573.06 282.85V282.83ZM662.9 152.04V152.06C671.88 162.64 676.59 177.68 676.59 197.62C676.59 217.56 671.88 232.67 662.9 243.38C654.03 253.84 641.21 259.26 623.89 259.26C606.57 259.26 593.88 253.85 584.87 243.37C575.89 232.66 571.19 217.55 571.19 197.62C571.19 177.69 575.9 162.64 584.87 152.06C593.88 141.45 606.71 135.99 623.89 135.99C641.07 135.99 654.02 141.46 662.9 152.05V152.04Z"/><path d="M442.58 288.81V292.31H485.31V161.12C488.3 157.01 493.27 152.98 500.56 149.17H500.58C508.24 145.1 516.6 143.06 525.73 143.06C527.84 143.06 529.66 143.18 531.2 143.4L531.33 143.42H531.46C533.15 143.54 534.7 143.77 536.11 144.09L540.02 144.99L540.39 140.99L543.74 104.14L544 101.25L541.21 100.45C538.25 99.6 535.07 99.2 531.69 99.2C521.3 99.2 511.52 102.21 502.43 108.14C495.18 112.83 487.75 119.57 480.13 128.27L477.09 105.96L476.68 102.93H442.58V288.81Z"/><path d="M431.77 265.73C425.4 265.73 420.67 264.38 417.7 261.71L417.54 261.56C414.76 258.73 412.91 254.51 412.04 249.04C411.29 243.24 410.92 235.99 410.92 227.4V190.17C410.92 168.32 408.73 150.79 404.41 138.07C400.09 125.35 393.15 116.21 383.77 110.91C374.36 105.46 361.84 102.71 346.53 102.71C345.62 102.71 344.72 102.72 343.82 102.74C332.82 102.99 322.17 104.79 312.11 108.1C301.23 111.56 292.03 116.13 284.75 121.69L286 128.7L289.59 148.86C294.41 145.52 299.01 142.74 303.36 140.54C307.71 138.33 311.81 136.7 315.63 135.65C323.43 133.54 330.82 132.48 337.6 132.48C350.44 132.48 360.4 135.17 367.19 140.48C373.5 145.43 376.93 155.7 377.38 171.02L377.48 174.52L373.98 174.62C365.79 174.85 357.12 175.58 348.22 176.77C338.19 178.01 328.37 180.14 319 183.1C309.6 185.95 300.96 189.89 293.31 194.82C285.8 199.63 279.69 205.79 275.14 213.14L275.07 213.25C270.62 220.54 268.37 229.43 268.37 239.68C268.37 249.93 270.68 258.95 275.25 266.85L275.32 266.96C280.01 274.81 286.62 281.1 294.98 285.65C303.39 290.21 313.34 292.53 324.57 292.53C335.8 292.53 346.96 290.02 356.21 285.08C363.95 280.96 370.92 275.72 376.95 269.51L380.36 266L382.58 270.36C384.46 274.06 386.55 277.39 388.78 280.25C391.76 284.07 396.08 287.07 401.62 289.16H402.44L402.9 289.62C408.78 291.55 416.98 292.53 427.3 292.53H429.9L435.11 265.73H431.77ZM377.42 241.18L376.72 242.12C371.51 249.09 364.8 254.78 356.77 259.03L356.56 259.14C356.47 259.19 356.38 259.24 356.28 259.29L356 259.44C347.96 263.61 339.52 265.73 330.9 265.73C322.28 265.73 315.77 263.55 310.47 259.25L310.39 259.18C305.23 254.73 302.61 247.55 302.61 237.82C302.61 228.8 305.18 221.35 310.24 215.67C315.31 209.98 323.39 205.66 334.25 202.83C344.47 200.19 357.77 198.49 373.76 197.76L377.42 197.6V241.18Z"/></svg>`;

// Tarout mark (public/logo-small.svg) in brand green, used as the tab favicon so
// the loopback page reads as Tarout, not a blank 127.0.0.1 origin.
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 53 43"><path fill="#31b45d" d="M50.992 0H41.8989C40.8732 0 40.0294 0.8438 40.0294 1.86952V5.04345C40.0294 5.66275 39.5272 6.16497 38.9079 6.16497H35.5433C34.924 6.16497 34.4218 5.66275 34.4218 5.04345V1.86952C34.4218 0.8438 33.578 0 32.5523 0H20.9636C19.9378 0 19.094 0.8438 19.094 1.86952V5.04345C19.094 5.66275 18.5918 6.16497 17.9725 6.16497H14.6196C14.0003 6.16497 13.4981 5.66275 13.4981 5.04345V1.86952C13.4981 0.8438 12.6543 0 11.6285 0H2.52382C1.4981 0 0.654297 0.8438 0.654297 1.86952V18.2559C0.654297 19.3658 1.46617 20.3093 2.56446 20.4738L12.4443 21.9562C13.5426 22.1207 14.3544 23.0632 14.3544 24.1731V41.144C14.3544 41.7633 14.8567 42.2655 15.476 42.2655H38.0389C38.6582 42.2655 39.1604 41.7633 39.1604 41.144V23.6922C39.1604 22.5475 40.0226 21.5876 41.1596 21.4637L50.8604 20.4051C51.9984 20.2812 52.8596 19.3203 52.8596 18.1756V1.86952C52.8596 0.8438 52.0158 0 50.9901 0H50.992ZM30.497 33.6456H23.0198V22.2436C23.0198 20.1932 24.7075 18.5056 26.7579 18.5056C28.8084 18.5056 30.496 20.1932 30.496 22.2436V33.6456H30.497Z"/></svg>`,
)}`;

/**
 * Full-page HTML for the CLI's local OAuth callback result, rendered to match
 * the Tarout dashboard's dark surface (the screen the user was just looking at).
 * Fully self-contained — inline CSS + inline SVG, zero network requests — so it
 * renders correctly offline on the 127.0.0.1 loopback server. All dynamic text
 * is HTML-escaped.
 */
export function renderCliAuthPage(options: {
	status: "success" | "error";
	title: string;
	lines: string[];
}): string {
	const isSuccess = options.status === "success";
	// Brand green for success (matches --success in the dark theme); destructive
	// red for failure. Space-separated HSL channels so we can add alpha inline.
	const accent = isSuccess ? "140 57% 45%" : "0 84% 62%";
	const icon = isSuccess
		? `<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
		: `<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	const paragraphs = options.lines
		.filter((line) => line.length > 0)
		.map((line) => `<p class="msg">${escapeHtml(line)}</p>`)
		.join("\n\t\t\t");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · Tarout</title>
<link rel="icon" href="${FAVICON_HREF}">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root { --accent: ${accent}; }
  html, body { height: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background-color: #0b0b0b;
    background-image:
      radial-gradient(52% 40% at 82% -6%, hsla(140, 60%, 46%, 0.10), transparent 66%),
      radial-gradient(40% 34% at 6% 8%, hsla(140, 60%, 46%, 0.05), transparent 64%);
    background-attachment: fixed;
    background-repeat: no-repeat;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image:
      linear-gradient(hsla(0, 0%, 100%, 0.022) 1px, transparent 1px),
      linear-gradient(90deg, hsla(0, 0%, 100%, 0.022) 1px, transparent 1px);
    background-size: 44px 44px;
    -webkit-mask-image: radial-gradient(130% 90% at 50% 0%, #000 30%, transparent 80%);
    mask-image: radial-gradient(130% 90% at 50% 0%, #000 30%, transparent 80%);
  }
  .card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 400px;
    padding: 44px 40px 40px;
    text-align: center;
    background: #151515;
    border: 1px solid #262626;
    border-radius: 16px;
    box-shadow:
      inset 0 1px 0 0 hsla(0, 0%, 100%, 0.04),
      0 4px 10px -2px hsla(0, 0%, 0%, 0.55),
      0 24px 56px -12px hsla(0, 0%, 0%, 0.65);
    animation: rise 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .wordmark {
    display: block;
    width: 116px;
    height: auto;
    margin: 0 auto 30px;
    color: #fff;
    opacity: 0.92;
  }
  .badge {
    position: relative;
    width: 74px;
    height: 74px;
    margin: 0 auto 24px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    color: hsl(var(--accent));
    background: hsl(var(--accent) / 0.12);
    border: 1px solid hsl(var(--accent) / 0.28);
  }
  .badge::before {
    content: "";
    position: absolute;
    inset: -28%;
    border-radius: inherit;
    background: radial-gradient(circle, hsl(var(--accent) / 0.30), transparent 70%);
    filter: blur(10px);
    z-index: -1;
  }
  .badge::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    border: 1px solid hsl(var(--accent) / 0.55);
    animation: ring 1000ms ease-out forwards;
  }
  .icon {
    width: 34px;
    height: 34px;
  }
  .icon path {
    stroke-dasharray: 40;
    stroke-dashoffset: 40;
    animation: draw 460ms 140ms ease-out forwards;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: #fff;
  }
  .msg {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.55;
    color: #9a9a9a;
  }
  .msg + .msg { margin-top: 8px; }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ring {
    from { transform: scale(1); opacity: 0.7; }
    to   { transform: scale(1.7); opacity: 0; }
  }
  @keyframes draw {
    to { stroke-dashoffset: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card { animation: none; }
    .badge::after { animation: none; opacity: 0; }
    .icon path { animation: none; stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
  <main class="card">
    ${TAROUT_WORDMARK}
    <div class="badge" aria-hidden="true">${icon}</div>
    <h1>${escapeHtml(options.title)}</h1>
    ${paragraphs}
  </main>
</body>
</html>`;
}

export function startAuthServer(options: StartAuthServerOptions): Promise<{
	port: number;
	state: string;
	codeChallenge: string;
	waitForCallback: () => Promise<AuthCallbackData>;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const app = express();
		const expectedState = options.state ?? createAuthState();
		const codeVerifier = options.codeVerifier ?? createPkceVerifier();
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(expectedState)) {
			throw new Error("Invalid authentication state.");
		}
		if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
			throw new Error("Invalid PKCE verifier.");
		}
		const codeChallenge = createPkceChallenge(codeVerifier);
		// biome-ignore lint/style/useConst: server is declared before assignment due to closure scope requirements
		let server: Server;
		let callbackResolver: (data: AuthCallbackData) => void;
		let callbackRejecter: (error: Error) => void;

		const callbackPromise = new Promise<AuthCallbackData>((res, rej) => {
			callbackResolver = res;
			callbackRejecter = rej;
		});

		let callbackStarted = false;

		app.get("/callback", async (req, res) => {
			const { code, error, state } = req.query;

			if (
				!state ||
				Array.isArray(state) ||
				!safeEqual(String(state), expectedState)
			) {
				res.status(400).send("Invalid authentication state");
				return;
			}

			if (error) {
				res.send(
					renderCliAuthPage({
						status: "error",
						title: "Authentication failed",
						lines: [String(error), "You can close this window and try again."],
					}),
				);
				callbackRejecter(new Error(String(error)));
				return;
			}

			if (!code || Array.isArray(code)) {
				res.status(400).send("Missing required authorization code");
				return;
			}
			if (!/^[A-Za-z0-9_-]{43}$/.test(String(code))) {
				res.status(400).send("Invalid authorization code");
				return;
			}

			if (callbackStarted) {
				res.status(409).send("Authentication callback already received");
				return;
			}
			callbackStarted = true;

			let authData: AuthCallbackData;
			try {
				authData = await options.exchangeCode(String(code), codeVerifier);
			} catch (error) {
				res.status(502).send(
					renderCliAuthPage({
						status: "error",
						title: "Authentication failed",
						lines: [
							"We couldn't complete the exchange with Tarout.",
							"Return to the terminal and try again.",
						],
					}),
				);
				callbackRejecter(
					error instanceof Error
						? error
						: new Error("Authentication exchange failed"),
				);
				return;
			}

			res.send(
				renderCliAuthPage({
					status: "success",
					title: "Authenticated!",
					lines: ["You can close this window and return to the terminal."],
				}),
			);

			callbackResolver(authData);
		});

		// Timeout after 5 minutes
		const timeout = setTimeout(
			() => {
				callbackRejecter(
					new Error("Authentication timed out. Please try again."),
				);
				server.close();
			},
			options.timeoutMs ?? 5 * 60 * 1000,
		);
		timeout.unref?.();

		const close = () => {
			clearTimeout(timeout);
			server.close();
		};

		// Find an available port
		server = app.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			resolve({
				port,
				state: expectedState,
				codeChallenge,
				waitForCallback: () => callbackPromise,
				close,
			});
		});
	});
}
