import "server-only";

export type RuntimeEnvironment = "local" | "test" | "production";

export interface ServerConfig {
  runtime: RuntimeEnvironment;
  supabase: {
    url: string;
    publishableKey: string;
    serviceRoleKey: string;
  };
  app: {
    url: string;
    origin: string;
  };
  email: {
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      password: string;
    } | null;
    from: string;
    isDevLogger: boolean;
  };
  publicAbuse: {
    hmacSecret: string;
    trustedProxySecret: string;
    sharedDevBucket: boolean;
    clientIpSource: "trusted-proxy" | "vercel";
  };
  auth: {
    requireEmailConfirmation: boolean;
  };
}

export function resolveRuntimeEnvironment(
  env: Record<string, string | undefined> = process.env,
  explicitRuntime?: RuntimeEnvironment,
): RuntimeEnvironment {
  const appEnv = env.APP_ENV?.toLowerCase().trim();
  const nodeEnv = env.NODE_ENV?.toLowerCase().trim();

  if (
    nodeEnv === "production" ||
    appEnv === "production" ||
    appEnv === "staging"
  ) {
    return "production";
  }

  if (explicitRuntime) {
    return explicitRuntime;
  }

  if (appEnv === "local" || appEnv === "development") {
    return "local";
  }
  if (appEnv === "test") {
    return "test";
  }

  if (nodeEnv === "test") {
    return "test";
  }

  return "local";
}

function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower.startsWith("127.")
  );
}

export function parseServerConfig(
  env: Record<string, string | undefined> = process.env,
  overrideRuntime?: RuntimeEnvironment,
): ServerConfig {
  const runtime = resolveRuntimeEnvironment(env, overrideRuntime);

  // 1. App URL & Canonical Origin
  const rawAppUrl =
    env.NEXT_PUBLIC_APP_URL?.trim() ||
    (runtime === "production" ? "" : "http://localhost:3000");

  if (!rawAppUrl) {
    throw new Error("Configuration error: NEXT_PUBLIC_APP_URL is required.");
  }
  if (!isValidUrl(rawAppUrl)) {
    throw new Error(
      "Configuration error: NEXT_PUBLIC_APP_URL must be a valid absolute URL.",
    );
  }

  const parsedAppUrl = new URL(rawAppUrl);
  if (runtime === "production") {
    if (parsedAppUrl.protocol !== "https:") {
      throw new Error(
        "Configuration error: NEXT_PUBLIC_APP_URL must use HTTPS in production.",
      );
    }
    if (isLoopbackHost(parsedAppUrl.hostname)) {
      throw new Error(
        "Configuration error: NEXT_PUBLIC_APP_URL cannot be localhost or a loopback address in production.",
      );
    }
  }

  const origin = parsedAppUrl.origin;

  // 2. Supabase Configuration
  const supabaseUrl =
    env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    (runtime === "production" ? "" : "http://127.0.0.1:54321");
  if (!supabaseUrl || !isValidUrl(supabaseUrl)) {
    throw new Error(
      "Configuration error: NEXT_PUBLIC_SUPABASE_URL must be a valid absolute URL.",
    );
  }

  const publishableKey =
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    (runtime === "production"
      ? ""
      : "sb_pub_default_local_dev_key_32_chars_long");
  if (!publishableKey) {
    throw new Error(
      "Configuration error: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required and cannot be empty.",
    );
  }

  const serviceRoleKey =
    env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    (runtime === "production"
      ? ""
      : "sb_service_default_local_dev_key_32_chars");
  if (!serviceRoleKey) {
    throw new Error(
      "Configuration error: SUPABASE_SERVICE_ROLE_KEY is required for server operations.",
    );
  }

  // 3. Email Configuration (SMTP through nodemailer)
  const smtpHost = env.SMTP_HOST?.trim() || "";
  const smtpUser = env.SMTP_USER?.trim() || "";
  const smtpPassword = env.SMTP_PASSWORD?.trim() || "";
  const smtpConfigured = Boolean(smtpHost && smtpUser && smtpPassword);
  if (!smtpConfigured && (smtpHost || smtpUser || smtpPassword)) {
    throw new Error(
      "Configuration error: SMTP_HOST, SMTP_USER and SMTP_PASSWORD must all be set, or all left unset.",
    );
  }

  const smtpPort = Number(env.SMTP_PORT?.trim() || "587");
  if (
    smtpConfigured &&
    (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
  ) {
    throw new Error(
      "Configuration error: SMTP_PORT must be a whole number from 1 to 65535.",
    );
  }

  const smtp = smtpConfigured
    ? {
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        user: smtpUser,
        password: smtpPassword,
      }
    : null;
  // SMTP logins can be technical identifiers rather than verified senders.
  const emailFrom = env.EMAIL_FROM?.trim() || "";
  if (smtpConfigured && !emailFrom) {
    throw new Error(
      "Configuration error: EMAIL_FROM must be set when SMTP is configured.",
    );
  }
  const isDevLogger = !smtp && (runtime === "local" || runtime === "test");

  // 4. Public-Abuse & Ingress Secrets
  const hmacSecret = env.PUBLIC_ABUSE_HMAC_SECRET?.trim() || "";
  const trustedProxySecret =
    env.PUBLIC_ABUSE_TRUSTED_PROXY_SECRET?.trim() || "";
  const sharedDevBucketRaw =
    env.PUBLIC_ABUSE_SHARED_DEV_BUCKET?.trim().toLowerCase();
  const sharedDevBucket = sharedDevBucketRaw === "true";

  const clientIpSourceRaw =
    env.PUBLIC_ABUSE_CLIENT_IP_SOURCE?.trim().toLowerCase();
  if (
    clientIpSourceRaw &&
    clientIpSourceRaw !== "trusted-proxy" &&
    clientIpSourceRaw !== "vercel"
  ) {
    throw new Error(
      'Configuration error: PUBLIC_ABUSE_CLIENT_IP_SOURCE must be "trusted-proxy" or "vercel".',
    );
  }
  const clientIpSource =
    clientIpSourceRaw === "vercel" ? "vercel" : "trusted-proxy";
  if (clientIpSource === "vercel" && env.VERCEL?.trim() !== "1") {
    throw new Error(
      "Configuration error: PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel requires running on Vercel (VERCEL=1).",
    );
  }

  if (hmacSecret.length < 32) {
    throw new Error(
      "Configuration error: PUBLIC_ABUSE_HMAC_SECRET must be at least 32 characters long.",
    );
  }
  const requiresTrustedProxySecret =
    clientIpSource === "trusted-proxy" &&
    (runtime === "production" || !sharedDevBucket);
  if (requiresTrustedProxySecret && trustedProxySecret.length < 32) {
    throw new Error(
      "Configuration error: PUBLIC_ABUSE_TRUSTED_PROXY_SECRET must be at least 32 characters long.",
    );
  }
  if (
    requiresTrustedProxySecret &&
    trustedProxySecret &&
    hmacSecret === trustedProxySecret
  ) {
    throw new Error(
      "Configuration error: PUBLIC_ABUSE_HMAC_SECRET and PUBLIC_ABUSE_TRUSTED_PROXY_SECRET cannot be identical.",
    );
  }

  if (runtime !== "local" && sharedDevBucket) {
    throw new Error(
      "Configuration error: PUBLIC_ABUSE_SHARED_DEV_BUCKET can only be enabled in local runtime.",
    );
  }

  // 5. Auth Dev Toggles
  const requireEmailConfirmationRaw =
    env.NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION?.trim().toLowerCase();
  const requireEmailConfirmation = requireEmailConfirmationRaw !== "false";

  if (runtime === "production" && requireEmailConfirmationRaw === "false") {
    throw new Error(
      "Configuration error: NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION cannot be set to false in production.",
    );
  }

  return {
    runtime,
    supabase: {
      url: supabaseUrl,
      publishableKey,
      serviceRoleKey,
    },
    app: {
      url: rawAppUrl,
      origin,
    },
    email: {
      smtp,
      from: emailFrom,
      isDevLogger,
    },
    publicAbuse: {
      hmacSecret,
      trustedProxySecret,
      sharedDevBucket,
      clientIpSource,
    },
    auth: {
      requireEmailConfirmation,
    },
  };
}

export function getServerConfig(): ServerConfig {
  return parseServerConfig(process.env);
}

export function getAppOrigin(): string {
  return getServerConfig().app.origin;
}

export function validateProductionRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  return parseServerConfig(env, "production");
}
