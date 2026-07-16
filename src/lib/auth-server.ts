import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express from "express";

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

interface StartAuthServerOptions {
	state?: string;
}

function createAuthState(): string {
	return randomBytes(32).toString("base64url");
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

export function startAuthServer(options: StartAuthServerOptions = {}): Promise<{
	port: number;
	state: string;
	waitForCallback: () => Promise<AuthCallbackData>;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const app = express();
		const expectedState = options.state ?? createAuthState();
		// biome-ignore lint/style/useConst: server is declared before assignment due to closure scope requirements
		let server: Server;
		let callbackResolver: (data: AuthCallbackData) => void;
		let callbackRejecter: (error: Error) => void;

		const callbackPromise = new Promise<AuthCallbackData>((res, rej) => {
			callbackResolver = res;
			callbackRejecter = rej;
		});

		app.get("/callback", (req, res) => {
			const {
				token,
				userId,
				userEmail,
				userName,
				organizationId,
				organizationName,
				projectId,
				projectName,
				projectSlug,
				environmentId,
				environmentName,
				error,
				state,
			} = req.query;

			if (
				!state ||
				Array.isArray(state) ||
				!safeEqual(String(state), expectedState)
			) {
				res.status(400).send("Invalid authentication state");
				return;
			}

			if (error) {
				res.send(`
	          <!DOCTYPE html>
          <html>
            <head>
              <title>Tarout</title>
              <style>
                body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
                .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #dc2626; margin-bottom: 16px; }
                p { color: #666; }
              </style>
            </head>
	            <body>
	              <div class="container">
	                <h1>Authentication Failed</h1>
	                <p>${escapeHtml(error)}</p>
	                <p>You can close this window and try again.</p>
	              </div>
	            </body>
          </html>
        `);
				callbackRejecter(new Error(String(error)));
				return;
			}

			const missing: string[] = [];
			if (!token) missing.push("token");
			if (!userId) missing.push("userId");
			if (!userEmail) missing.push("userEmail");
			if (!organizationId) missing.push("organizationId");
			if (!organizationName) missing.push("organizationName");
			if (!projectId) missing.push("projectId");
			if (!projectName) missing.push("projectName");
			if (missing.length > 0) {
				const list = missing.join(", ");
				res.status(400).send(`Missing required parameters: ${list}`);
				callbackRejecter(
					new Error(`Missing required parameters from auth callback: ${list}`),
				);
				return;
			}

			res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Tarout</title>
            <style>
              body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
              .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              h1 { color: #16a34a; margin-bottom: 16px; }
              p { color: #666; }
              .checkmark { font-size: 64px; margin-bottom: 16px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="checkmark">✓</div>
              <h1>Authenticated!</h1>
              <p>You can close this window and return to the terminal.</p>
            </div>
          </body>
        </html>
      `);

			callbackResolver({
				token: String(token),
				userId: String(userId),
				userEmail: String(userEmail),
				userName: userName ? String(userName) : undefined,
				organizationId: String(organizationId),
				organizationName: String(organizationName),
				projectId: String(projectId),
				projectName: String(projectName),
				projectSlug: projectSlug ? String(projectSlug) : undefined,
				environmentId: environmentId ? String(environmentId) : undefined,
				environmentName: environmentName ? String(environmentName) : undefined,
			});
		});

		// Timeout after 5 minutes
		const timeout = setTimeout(
			() => {
				callbackRejecter(
					new Error("Authentication timed out. Please try again."),
				);
				server.close();
			},
			5 * 60 * 1000,
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
				waitForCallback: () => callbackPromise,
				close,
			});
		});
	});
}
