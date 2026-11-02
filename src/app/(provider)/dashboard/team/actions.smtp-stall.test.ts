import { createServer, type AddressInfo, type Socket } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireProviderRole: vi.fn(),
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/features/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/auth")>()),
  requireProviderRole: mocks.requireProviderRole,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

// Nothing is mocked around nodemailer: the real transport meets a server that
// accepts the TCP connection and never sends its greeting.
import { inviteStaffAction } from "./actions";

const SMTP_PASSWORD = "app_password_stall_test_51ab";

const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: "production",
  APP_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://tracknologia.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_production_test_key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-production-test-key",
  PUBLIC_ABUSE_HMAC_SECRET: "hmac_secret_stall_test_32_chars_minimum",
  PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: "proxy_secret_stall_test_32_chars_min",
  NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION: "true",
  EMAIL_FROM: "Tracknologia <project@gmail.com>",
};

const closers: Array<() => Promise<void>> = [];

async function startStalledSmtp() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => done());
      }),
  );
  return (server.address() as AddressInfo).port;
}

function inviteFormData(email: string) {
  const formData = new FormData();
  formData.set("email", email);
  return formData;
}

function inviteDatabase(): SupabaseClient {
  let created = false;
  return {
    rpc: vi.fn(async () => {
      const row = {
        invitation_id: "invitation-1",
        provider_id: "provider-1",
        email: "tech@shop.com",
        role: "STAFF",
        created_at: "2026-10-31T09:00:00.000Z",
        expires_at: "2026-11-07T09:00:00.000Z",
        reused: created,
      };
      created = true;
      return { data: [row], error: null };
    }),
  } as unknown as SupabaseClient;
}

function spyConsole() {
  return [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries(PRODUCTION_ENV)) {
    vi.stubEnv(name, value);
  }
  mocks.requireProviderRole.mockResolvedValue({
    userId: "owner-1",
    providerId: "provider-1",
    providerName: "Apex Electronics",
    providerType: "SHOP",
    role: "OWNER",
  });
  mocks.createClient.mockResolvedValue(inviteDatabase());
});

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("inviteStaffAction when the SMTP server stalls", () => {
  it("still returns the first invite's one-time link, and a repeat invite gets no link", async () => {
    const port = await startStalledSmtp();
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", String(port));
    vi.stubEnv("SMTP_USER", "project@gmail.com");
    vi.stubEnv("SMTP_PASSWORD", SMTP_PASSWORD);
    const spies = spyConsole();

    const first = await inviteStaffAction(
      null,
      inviteFormData("tech@shop.com"),
    );

    expect(first.emailDeliveryFailed).toBe(true);
    expect(first.token).toMatch(/^inv_[0-9a-f]{48}$/);
    expect(first.inviteUrl).toBe(`/register?invite=${first.token}`);

    const second = await inviteStaffAction(
      null,
      inviteFormData("tech@shop.com"),
    );

    expect(second).toEqual({
      success:
        "A pending invitation already exists for tech@shop.com. Revoke it and invite again to create a fresh invitation link.",
      reused: true,
    });
    expect(second.token).toBeUndefined();
    expect(second.inviteUrl).toBeUndefined();

    const logged = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join(" ");
    expect(logged).not.toContain(SMTP_PASSWORD);
    expect(logged).not.toContain(first.token ?? "");
  }, 20_000);
});
