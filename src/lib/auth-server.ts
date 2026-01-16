import type { Server } from "node:http";
import express from "express";

export interface AuthCallbackData {
	token: string;
	userId: string;
	userEmail: string;
	userName?: string;
	organizationId: string;
	organizationName: string;
	environmentId: string;
	environmentName: string;
}

export function startAuthServer(): Promise<{
	port: number;
	waitForCallback: () => Promise<AuthCallbackData>;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const app = express();
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
				environmentId,
				environmentName,
				error,
			} = req.query;

			if (error) {
				res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Tarout CLI - Authentication Failed</title>
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
                <p>${error}</p>
                <p>You can close this window and try again.</p>
              </div>
            </body>
          </html>
        `);
				callbackRejecter(new Error(String(error)));
				return;
			}

			if (
				!token ||
				!userId ||
				!userEmail ||
				!organizationId ||
				!organizationName ||
				!environmentId ||
				!environmentName
			) {
				res.status(400).send("Missing required parameters");
				callbackRejecter(
					new Error("Missing required parameters from auth callback"),
				);
				return;
			}

			res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Tarout CLI - Authenticated</title>
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
				environmentId: String(environmentId),
				environmentName: String(environmentName),
			});
		});

		// Find an available port
		server = app.listen(0, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			resolve({
				port,
				waitForCallback: () => callbackPromise,
				close: () => server.close(),
			});
		});

		// Timeout after 5 minutes
		setTimeout(
			() => {
				callbackRejecter(
					new Error("Authentication timed out. Please try again."),
				);
				server.close();
			},
			5 * 60 * 1000,
		);
	});
}
