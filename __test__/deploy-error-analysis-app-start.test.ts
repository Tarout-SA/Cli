import { describe, expect, it } from "vitest";
import { analyzeDeploymentError } from "../src/lib/errors.js";

// Captured from production 2026-09-23: an app that exits on boot was analyzed
// as "docker_build / Invalid Dockerfile syntax" because of the platform's own
// curl/wget warning line.
const START_CRASH = [
	"New container started.",
	"Waiting for healthcheck to pass on the new container.",
	'Attempt 1 of 12 | Healthcheck status: "unhealthy"',
	"New container is unhealthy.",
	"Container logs:",
	"B11 boot crash: missing DATABASE_URL",
	"WARNING: Dockerfile or Docker Image based deployment detected. The healthcheck needs a curl or wget command to check the health of the application.",
	"New container is not healthy, rolling back to the old container.",
	"✗ Build failed - caused by your application",
	"Your app failed to start.",
];

describe("analyzeDeploymentError", () => {
	it("calls a crash on boot a start failure, not a Dockerfile problem", () => {
		const analysis = analyzeDeploymentError(START_CRASH, "Your app failed to start. - New container is unhealthy.");
		expect(analysis.category).toBe("app_start");
		expect(analysis.type).toBe("runtime_error");
		expect(analysis.possibleCauses.join(" ")).not.toMatch(/Dockerfile/);
	});

	it("still recognises a genuine Dockerfile build failure", () => {
		const analysis = analyzeDeploymentError(["COPY failed: file not found in build context", "failed to build: Dockerfile:7"]);
		expect(analysis.category).toBe("docker_build");
	});
});
