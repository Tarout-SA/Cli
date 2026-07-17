import { describe, expect, it } from "vitest";
import { renderCliAuthPage } from "../src/lib/auth-server";

// The callback page renders on the CLI's 127.0.0.1 loopback origin, often with
// no network. These guards keep it fully self-contained (no external stylesheet,
// font, script, or image loads) and keep dynamic text HTML-escaped.
describe("renderCliAuthPage", () => {
	const success = renderCliAuthPage({
		status: "success",
		title: "Authenticated!",
		lines: ["You can close this window and return to the terminal."],
	});

	it("renders the branded success state", () => {
		expect(success).toContain("<!DOCTYPE html>");
		expect(success).toContain("Authenticated!");
		expect(success).toContain('aria-label="Tarout"');
	});

	it("stays fully self-contained — no external resource loads", () => {
		expect(success).not.toMatch(/<script/i);
		expect(success).not.toContain('rel="stylesheet"');
		expect(success).not.toContain("@import");
		expect(success).not.toContain("fonts.googleapis");
		// No <img>/<link>/<script> src, and the favicon must be a data: URI.
		expect(success).not.toMatch(/\ssrc=/i);
		expect(success).not.toMatch(/href="https?:/i);
		// The only remaining absolute URL may be the SVG xmlns identifier, which
		// browsers never fetch. Nothing else should look like a network request.
		const withoutSvgNs = success.replaceAll(
			"http://www.w3.org/2000/svg",
			"",
		);
		expect(withoutSvgNs).not.toContain("http://");
		expect(withoutSvgNs).not.toContain("https://");
	});

	it("HTML-escapes dynamic line text", () => {
		const html = renderCliAuthPage({
			status: "error",
			title: "Authentication failed",
			lines: ['<script>alert("xss")</script>', "try again"],
		});
		expect(html).not.toContain('<script>alert("xss")</script>');
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("Authentication failed");
	});
});
