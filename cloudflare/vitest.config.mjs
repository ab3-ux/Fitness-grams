import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: path.join(projectDirectory, "wrangler.test.toml")
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(projectDirectory, "migrations"))
        }
      }
    }))
  ],
  test: {
    include: ["test/*.integration.test.mjs"],
    testTimeout: 20_000
  }
});
