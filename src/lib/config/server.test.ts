import { describe, expect, it } from "vitest";
import {
  parseServerConfig,
  resolveRuntimeEnvironment,
  validateProductionRuntimeConfig,
} from "./server";

const VALID_PROD_ENV: Record<string, string> = {
  NODE_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://app.tracknologia.com",
  NEXT_PUBLIC_SUPABASE_URL: "https://xyz.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_pub_123456789012345678901234567890",
  SUPABASE_SERVICE_ROLE_KEY: "sb_service_123456789012345678901234567890",
  SMTP_HOST: "smtp.gmail.com",
  SMTP_USER: "project@gmail.com",
  SMTP_PASSWORD: "app_password_1234567890",
  EMAIL_FROM: "Tracknologia <project@gmail.com>",
  PUBLIC_ABUSE_HMAC_SECRET: "hmac_secret_32_chars_minimum_length_12345",
  PUBLIC_ABUSE_TRUSTED_PROXY_SECRET:
    "proxy_secret_32_chars_minimum_length_67890",
};

describe("Configuration Seam (src/lib/config/server.ts)", () => {
  describe("Runtime environment resolution", () => {
    it("resolves production when APP_ENV or NODE_ENV is production/staging", () => {
      expect(resolveRuntimeEnvironment({ NODE_ENV: "production" })).toBe(
        "production",
      );
      expect(resolveRuntimeEnvironment({ APP_ENV: "staging" })).toBe(
        "production",
      );
      expect(resolveRuntimeEnvironment({ APP_ENV: "production" })).toBe(
        "production",
      );
    });

    it.each(["local", "development", "test"])(
      "does not let APP_ENV=%s downgrade a production Node process",
      (appEnv) => {
        expect(
          resolveRuntimeEnvironment({
            NODE_ENV: "production",
            APP_ENV: appEnv,
          }),
        ).toBe("production");
      },
    );

    it("does not let an explicit local override downgrade a production Node process", () => {
      expect(
        resolveRuntimeEnvironment({ NODE_ENV: "production" }, "local"),
      ).toBe("production");
    });

    it("resolves test when NODE_ENV is test", () => {
      expect(resolveRuntimeEnvironment({ NODE_ENV: "test" })).toBe("test");
    });

    it("defaults to local for development or unspecified", () => {
      expect(resolveRuntimeEnvironment({ NODE_ENV: "development" })).toBe(
        "local",
      );
      expect(resolveRuntimeEnvironment({})).toBe("local");
    });

    it("respects explicit runtime parameter", () => {
      expect(
        resolveRuntimeEnvironment({ NODE_ENV: "development" }, "production"),
      ).toBe("production");
    });
  });

  describe("Production configuration validation", () => {
    it("passes with complete valid production configuration", () => {
      const config = parseServerConfig(VALID_PROD_ENV, "production");
      expect(config.runtime).toBe("production");
      expect(config.app.origin).toBe("https://app.tracknologia.com");
      expect(config.email.isDevLogger).toBe(false);
      expect(config.email.smtp).not.toBeNull();
      expect(config.publicAbuse.sharedDevBucket).toBe(false);
    });

    it("executes validateProductionRuntimeConfig without throwing for valid env", () => {
      expect(() =>
        validateProductionRuntimeConfig(VALID_PROD_ENV),
      ).not.toThrow();
    });

    it("fails when NEXT_PUBLIC_APP_URL is missing or invalid", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, NEXT_PUBLIC_APP_URL: "" },
          "production",
        ),
      ).toThrow("NEXT_PUBLIC_APP_URL is required");

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, NEXT_PUBLIC_APP_URL: "not-a-url" },
          "production",
        ),
      ).toThrow("NEXT_PUBLIC_APP_URL must be a valid absolute URL");
    });

    it("fails when production app URL uses HTTP or loopback address", () => {
      expect(() =>
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            NEXT_PUBLIC_APP_URL: "http://app.tracknologia.com",
          },
          "production",
        ),
      ).toThrow("NEXT_PUBLIC_APP_URL must use HTTPS in production");

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, NEXT_PUBLIC_APP_URL: "https://localhost:3000" },
          "production",
        ),
      ).toThrow(
        "NEXT_PUBLIC_APP_URL cannot be localhost or a loopback address",
      );

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, NEXT_PUBLIC_APP_URL: "https://127.0.0.1:3000" },
          "production",
        ),
      ).toThrow(
        "NEXT_PUBLIC_APP_URL cannot be localhost or a loopback address",
      );
    });

    it("fails closed through normal config reads when production signals conflict", () => {
      expect(() =>
        parseServerConfig({
          ...VALID_PROD_ENV,
          APP_ENV: "local",
          NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        }),
      ).toThrow("NEXT_PUBLIC_APP_URL must use HTTPS in production");

      expect(
        parseServerConfig({ ...VALID_PROD_ENV, APP_ENV: "development" })
          .runtime,
      ).toBe("production");
    });

    it("fails when Supabase public or service credentials are missing", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, NEXT_PUBLIC_SUPABASE_URL: "" },
          "production",
        ),
      ).toThrow("NEXT_PUBLIC_SUPABASE_URL must be a valid absolute URL");

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" },
          "production",
        ),
      ).toThrow("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required");

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, SUPABASE_SERVICE_ROLE_KEY: "" },
          "production",
        ),
      ).toThrow("SUPABASE_SERVICE_ROLE_KEY is required");
    });

    it("allows production without SMTP settings, with email disabled", () => {
      const config = parseServerConfig(
        {
          ...VALID_PROD_ENV,
          SMTP_HOST: "",
          SMTP_USER: "",
          SMTP_PASSWORD: "",
          EMAIL_FROM: "",
        },
        "production",
      );
      expect(config.runtime).toBe("production");
      expect(config.email.smtp).toBeNull();
      expect(config.email.isDevLogger).toBe(false);
      expect(config.email.from).toBe("");
    });

    it("accepts Brevo credentials with a sender distinct from the SMTP login", () => {
      const config = parseServerConfig({
        ...VALID_PROD_ENV,
        SMTP_HOST: "smtp-relay.brevo.com",
        SMTP_PORT: "587",
        SMTP_USER: "12345@smtp-brevo.com",
        SMTP_PASSWORD: "smtp_key_test_only",
        EMAIL_FROM: "  Tracknologia <sender@example.test>  ",
      });
      expect(config.email.smtp).toEqual({
        host: "smtp-relay.brevo.com",
        port: 587,
        secure: false,
        user: "12345@smtp-brevo.com",
        password: "smtp_key_test_only",
      });
      expect(config.email.from).toBe("Tracknologia <sender@example.test>");
    });

    it("enables email with the full SMTP set, on port 587 without implicit TLS", () => {
      const config = parseServerConfig(VALID_PROD_ENV, "production");
      expect(config.email.smtp).toEqual({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        user: "project@gmail.com",
        password: "app_password_1234567890",
      });
      expect(config.email.from).toBe("Tracknologia <project@gmail.com>");
    });

    it("uses implicit TLS only for port 465 and honours EMAIL_FROM", () => {
      const config = parseServerConfig(
        {
          ...VALID_PROD_ENV,
          SMTP_PORT: "465",
          EMAIL_FROM: "Tracknologia <project@gmail.com>",
        },
        "production",
      );
      expect(config.email.smtp?.port).toBe(465);
      expect(config.email.smtp?.secure).toBe(true);
      expect(config.email.from).toBe("Tracknologia <project@gmail.com>");
    });

    it.each(["local", "test", "production"] as const)(
      "requires an explicit sender for configured SMTP in %s without leaking credentials",
      (runtime) => {
        for (const sender of [undefined, "", " \t "]) {
          expect(() =>
            parseServerConfig({
              ...VALID_PROD_ENV,
              NODE_ENV: runtime === "local" ? "development" : runtime,
              APP_ENV: runtime,
              SMTP_HOST: "smtp-relay.brevo.com",
              SMTP_USER: "12345@smtp-brevo.com",
              SMTP_PASSWORD: "smtp_key_sender_test_secret",
              EMAIL_FROM: sender,
            }),
          ).toThrow(
            /^Configuration error: EMAIL_FROM must be set when SMTP is configured\.$/,
          );
        }
      },
    );

    it("rejects a partly set SMTP configuration in every runtime", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, SMTP_USER: "", SMTP_PASSWORD: "" },
          "production",
        ),
      ).toThrow("SMTP_HOST, SMTP_USER and SMTP_PASSWORD must all be set");
      expect(() =>
        parseServerConfig(
          { NODE_ENV: "development", SMTP_HOST: "smtp.gmail.com" },
          "local",
        ),
      ).toThrow("SMTP_HOST, SMTP_USER and SMTP_PASSWORD must all be set");
    });

    it("rejects an invalid SMTP port when SMTP is configured", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, SMTP_PORT: "70000" },
          "production",
        ),
      ).toThrow("SMTP_PORT must be a whole number from 1 to 65535");
    });

    it("fails when rate-limiting secrets are too short or identical", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, PUBLIC_ABUSE_HMAC_SECRET: "short_secret" },
          "production",
        ),
      ).toThrow("PUBLIC_ABUSE_HMAC_SECRET must be at least 32 characters long");

      expect(() =>
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: "short_secret",
          },
          "production",
        ),
      ).toThrow(
        "PUBLIC_ABUSE_TRUSTED_PROXY_SECRET must be at least 32 characters long",
      );

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: "" },
          "production",
        ),
      ).toThrow(
        "PUBLIC_ABUSE_TRUSTED_PROXY_SECRET must be at least 32 characters long",
      );

      const sameSecret = "identical_secret_32_chars_minimum_length_12345";
      expect(() =>
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            PUBLIC_ABUSE_HMAC_SECRET: sameSecret,
            PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: sameSecret,
          },
          "production",
        ),
      ).toThrow(
        "PUBLIC_ABUSE_HMAC_SECRET and PUBLIC_ABUSE_TRUSTED_PROXY_SECRET cannot be identical",
      );
    });

    it("fails when development bypass flags are enabled in production", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, PUBLIC_ABUSE_SHARED_DEV_BUCKET: "true" },
          "production",
        ),
      ).toThrow(
        "PUBLIC_ABUSE_SHARED_DEV_BUCKET can only be enabled in local runtime",
      );

      expect(() =>
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION: "false",
          },
          "production",
        ),
      ).toThrow(
        "NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION cannot be set to false in production",
      );
    });
  });

  describe("Development / Local mode configuration", () => {
    const VALID_DEV_ENV: Record<string, string> = {
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "sb_pub_dev_key_32_chars_minimum_len_123",
      SUPABASE_SERVICE_ROLE_KEY: "sb_service_dev_key_32_chars_min_len_123",
      PUBLIC_ABUSE_HMAC_SECRET: "dev_hmac_secret_32_chars_minimum_length_1234",
      PUBLIC_ABUSE_TRUSTED_PROXY_SECRET:
        "dev_proxy_secret_32_chars_minimum_length_5678",
    };

    it("allows localhost URL and missing SMTP settings in dev mode", () => {
      const config = parseServerConfig(VALID_DEV_ENV, "local");
      expect(config.runtime).toBe("local");
      expect(config.app.origin).toBe("http://localhost:3000");
      expect(config.email.isDevLogger).toBe(true);
    });

    it("keeps explicit local and test execution available outside production", () => {
      expect(
        resolveRuntimeEnvironment({
          NODE_ENV: "development",
          APP_ENV: "local",
        }),
      ).toBe("local");
      expect(
        resolveRuntimeEnvironment({ NODE_ENV: "test", APP_ENV: "test" }),
      ).toBe("test");
    });

    it("allows dev bucket shortcut and email confirmation bypass in local mode", () => {
      const config = parseServerConfig(
        {
          ...VALID_DEV_ENV,
          PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: undefined,
          PUBLIC_ABUSE_SHARED_DEV_BUCKET: "true",
          NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION: "false",
        },
        "local",
      );
      expect(config.publicAbuse.sharedDevBucket).toBe(true);
      expect(config.auth.requireEmailConfirmation).toBe(false);
    });

    it.each([
      ["local", undefined],
      ["local", "short"],
      ["test", undefined],
      ["test", "short"],
    ])(
      "requires valid trusted proxy proof in %s without the shared bucket shortcut",
      (runtime, trustedProxySecret) => {
        expect(() =>
          parseServerConfig(
            {
              ...VALID_DEV_ENV,
              PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: trustedProxySecret,
            },
            runtime as "local" | "test",
          ),
        ).toThrow(
          "PUBLIC_ABUSE_TRUSTED_PROXY_SECRET must be at least 32 characters long",
        );
      },
    );

    it("rejects the shared bucket shortcut in test runtime", () => {
      expect(() =>
        parseServerConfig(
          {
            ...VALID_DEV_ENV,
            PUBLIC_ABUSE_SHARED_DEV_BUCKET: "true",
          },
          "test",
        ),
      ).toThrow(
        "PUBLIC_ABUSE_SHARED_DEV_BUCKET can only be enabled in local runtime",
      );
    });
  });

  describe("Client IP source", () => {
    it("defaults to the trusted proxy and still requires its secret in production", () => {
      expect(
        parseServerConfig(VALID_PROD_ENV, "production").publicAbuse
          .clientIpSource,
      ).toBe("trusted-proxy");

      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: undefined },
          "production",
        ),
      ).toThrow(
        "PUBLIC_ABUSE_TRUSTED_PROXY_SECRET must be at least 32 characters long",
      );
    });

    it("accepts vercel on Vercel without the trusted proxy secret", () => {
      const config = parseServerConfig(
        {
          ...VALID_PROD_ENV,
          VERCEL: "1",
          PUBLIC_ABUSE_CLIENT_IP_SOURCE: " Vercel ",
          PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: undefined,
        },
        "production",
      );
      expect(config.publicAbuse.clientIpSource).toBe("vercel");
      expect(config.publicAbuse.trustedProxySecret).toBe("");
      expect(config.publicAbuse.hmacSecret).toBe(
        VALID_PROD_ENV.PUBLIC_ABUSE_HMAC_SECRET,
      );
    });

    it("still requires the HMAC secret in vercel mode", () => {
      expect(() =>
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            VERCEL: "1",
            PUBLIC_ABUSE_CLIENT_IP_SOURCE: "vercel",
            PUBLIC_ABUSE_HMAC_SECRET: "short_secret",
          },
          "production",
        ),
      ).toThrow("PUBLIC_ABUSE_HMAC_SECRET must be at least 32 characters long");
    });

    it("rejects vercel mode outside Vercel without leaking secrets", () => {
      const secret = "vercel_mode_secret_value_1234567890_abcdef";
      expect(() =>
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            PUBLIC_ABUSE_CLIENT_IP_SOURCE: "vercel",
            PUBLIC_ABUSE_HMAC_SECRET: secret,
          },
          "production",
        ),
      ).toThrow(
        "Configuration error: PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel requires running on Vercel (VERCEL=1).",
      );

      try {
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            VERCEL: "0",
            PUBLIC_ABUSE_CLIENT_IP_SOURCE: "vercel",
            PUBLIC_ABUSE_HMAC_SECRET: secret,
          },
          "production",
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain(secret);
      }
    });

    it("rejects an unknown client IP source", () => {
      expect(() =>
        parseServerConfig(
          { ...VALID_PROD_ENV, PUBLIC_ABUSE_CLIENT_IP_SOURCE: "cloudflare" },
          "production",
        ),
      ).toThrow(
        'Configuration error: PUBLIC_ABUSE_CLIENT_IP_SOURCE must be "trusted-proxy" or "vercel".',
      );
    });
  });

  describe("Secret privacy invariant", () => {
    it("never includes secret keys in error messages", () => {
      const secret = "SUPER_SECRET_VALUE_12345678901234567890";
      try {
        parseServerConfig(
          {
            ...VALID_PROD_ENV,
            PUBLIC_ABUSE_HMAC_SECRET: secret,
            PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: secret,
          },
          "production",
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain(secret);
      }
    });
  });
});
