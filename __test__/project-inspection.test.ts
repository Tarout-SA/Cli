import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCurrentProject } from "../src/commands/deploy";

const tempDirs: string[] = [];

function createFixture(name: string, files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), `tarout-${name}-`));
	tempDirs.push(root);

	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = join(root, relativePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}

	return root;
}

afterEach(async () => {
	const { rmSync } = await import("node:fs");
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("Tarout deploy project inspection", () => {
	it("keeps a plain Node app on local upload with no managed resources", () => {
		const root = createFixture("node-static", {
			"package.json": JSON.stringify({
				name: "node-static",
				dependencies: { express: "^4.18.0" },
			}),
			"server.js": "import express from 'express';\nexpress().listen(process.env.PORT || 3000);\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("none");
		expect(inspection.storage).toBe(false);
		expect(inspection.git.hasGit).toBe(false);
	});

	it("detects a Next.js Prisma PostgreSQL app", () => {
		const root = createFixture("next-prisma-postgres", {
			"package.json": JSON.stringify({
				name: "next-prisma-postgres",
				dependencies: {
					"@prisma/client": "^5.0.0",
					next: "^15.0.0",
					react: "^19.0.0",
				},
			}),
			"prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
			"src/app/page.tsx": "export default function Page() { return <main />; }\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("postgres");
		expect(inspection.databaseReasons.join(" ")).toContain("Prisma");
		expect(inspection.storage).toBe(false);
	});

	it("detects a Laravel-style MySQL app", () => {
		const root = createFixture("laravel-mysql", {
			"composer.json": JSON.stringify({
				require: { php: "^8.2", "laravel/framework": "^11.0" },
			}),
			".env.example": "DB_CONNECTION=mysql\nMYSQL_HOST=127.0.0.1\nMYSQL_DATABASE=app\n",
			"config/database.php": "<?php return ['default' => env('DB_CONNECTION', 'mysql')];\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("mysql");
		expect(inspection.databaseReasons.join(" ")).toContain("mysql");
		expect(inspection.storage).toBe(false);
	});

	it("detects an Express app that needs file storage", () => {
		const root = createFixture("express-storage", {
			"package.json": JSON.stringify({
				name: "express-storage",
				dependencies: {
					"@aws-sdk/client-s3": "^3.600.0",
					express: "^4.18.0",
					multer: "^1.4.5",
				},
			}),
			"src/upload.ts": "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';\nconst bucket = process.env.S3_BUCKET;\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("none");
		expect(inspection.storage).toBe(true);
		expect(inspection.storageReasons.join(" ")).toContain("object storage");
	});

	it("detects Firebase storage usage as file storage", () => {
		const root = createFixture("firebase-storage", {
			"package.json": JSON.stringify({
				name: "firebase-storage",
				dependencies: {
					"firebase-admin": "^13.0.0",
				},
			}),
			"src/storage.ts":
				"import { getStorage } from 'firebase-admin/storage';\nconst bucket = process.env.FIREBASE_STORAGE_BUCKET;\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("none");
		expect(inspection.storage).toBe(true);
		expect(inspection.storageReasons.join(" ")).toContain("storage");
	});

	it("detects a Spring Boot + Postgres app (Maven pom.xml + application.properties)", () => {
		const root = createFixture("spring-maven-postgres", {
			"pom.xml": [
				'<?xml version="1.0" encoding="UTF-8"?>',
				"<project><dependencies>",
				"  <dependency>",
				"    <groupId>org.postgresql</groupId>",
				"    <artifactId>postgresql</artifactId>",
				"    <scope>runtime</scope>",
				"  </dependency>",
				"</dependencies></project>",
			].join("\n"),
			"src/main/resources/application.properties": [
				"spring.datasource.url=jdbc:postgresql://${PGHOST:localhost}:5432/${PGDATABASE:app}",
				"spring.datasource.username=${PGUSER:postgres}",
				"spring.datasource.driver-class-name=org.postgresql.Driver",
			].join("\n"),
			"src/main/java/com/example/App.java": "class App {}\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("postgres");
		expect(inspection.databaseReasons.join(" ").toLowerCase()).toContain(
			"postgres",
		);
	});

	it("detects a Spring Boot + MySQL app via Gradle build file", () => {
		const root = createFixture("spring-gradle-mysql", {
			"build.gradle": [
				"dependencies {",
				"  runtimeOnly 'com.mysql:mysql-connector-j'",
				"}",
			].join("\n"),
			"src/main/resources/application.properties":
				"spring.datasource.url=jdbc:mysql://${MYSQL_HOST:localhost}:3306/app\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("mysql");
		expect(inspection.databaseReasons.join(" ").toLowerCase()).toContain(
			"mysql",
		);
	});

	it("leaves a Spring Boot app with no datasource on 'none'", () => {
		const root = createFixture("spring-no-db", {
			"pom.xml":
				'<?xml version="1.0"?>\n<project><dependencies>\n  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>\n</dependencies></project>\n',
			"src/main/resources/application.properties": "server.port=8080\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("none");
	});

	it("detects a GitHub-backed Rails-style project without requiring GitHub", () => {
		const root = createFixture("rails-github", {
			"Gemfile": 'gem "rails"\ngem "pg"\n',
			"config/database.yml": "production:\n  url: <%= ENV['DATABASE_URL'] %>\n",
			".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/rails-github.git\n",
		});

		const inspection = inspectCurrentProject(root);

		expect(inspection.database).toBe("postgres");
		expect(inspection.git).toMatchObject({
			hasGit: true,
			provider: "GitHub",
			remoteUrl: "git@github.com:acme/rails-github.git",
		});
	});
});
