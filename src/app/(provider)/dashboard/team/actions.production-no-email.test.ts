import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireProviderRole: vi.fn(),
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
  createTransport: vi.fn(),
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

// Only the SMTP transport is faked. The config and email client run for real.
vi.mock("nodemailer", () => ({
  createTransport: mocks.createTransport,
}));

import { inviteStaffAction } from "./actions";

const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: "production",
  APP_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://tracknologia.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_production_test_key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-production-test-key",
  PUBLIC_ABUSE_HMAC_SECRET: "hmac_secret_no_email_test_32_chars_minimum",
  PUBLIC_ABUSE_TRUSTED_PROXY_SECRET: "proxy_secret_no_email_test_32_chars_min",
  NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION: "true",
  // Blank means unset: production runs with no SMTP settings.
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  EMAIL_FROM: "",
};

function inviteFormData(email: string) {
  const formData = new FormData();
  formData.set("email", email);
  return formData;
}

// The first insert creates the row; a second insert for the same email is the
// active pending invitation, which the RPC reports as reused.
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("inviteStaffAction in production without email", () => {
  it("creates the invitation, returns its link once, and never calls SMTP or logs the link", async () => {
    const spies = spyConsole();

    const first = await inviteStaffAction(
      null,
      inviteFormData("tech@shop.com"),
    );

    expect(first.emailDeliveryFailed).toBe(true);
    expect(first.token).toMatch(/^inv_[0-9a-f]{48}$/);
    expect(first.inviteUrl).toBe(`/register?invite=${first.token}`);
    expect(mocks.createTransport).not.toHaveBeenCalled();

    const logged = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String);
    const output = logged.join(" ");
    expect(output).not.toContain(first.token ?? "");
    expect(output).not.toContain("/register?invite=");
  });

  it("returns reused with no link for a second invite to the same email", async () => {
    const spies = spyConsole();
    const first = await inviteStaffAction(
      null,
      inviteFormData("tech@shop.com"),
    );

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
    expect(mocks.createTransport).not.toHaveBeenCalled();

    const output = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .join(" ");
    expect(output).not.toContain(first.token ?? "");
  });
});

describe("inviteStaffAction with Brevo SMTP", () => {
  it.each([true, false])(
    "preserves the invitation and its one-time link when email delivery succeeds=%s",
    async (delivered) => {
      const spies = spyConsole();
      vi.stubEnv("SMTP_HOST", "smtp-relay.brevo.com");
      vi.stubEnv("SMTP_PORT", "587");
      vi.stubEnv("SMTP_USER", "12345@smtp-brevo.com");
      vi.stubEnv("SMTP_PASSWORD", "smtp_key_invite_test_only");
      vi.stubEnv("EMAIL_FROM", "Tracknologia <sender@example.test>");
      const sendMail = vi.fn();
      if (delivered) {
        sendMail.mockResolvedValue({ messageId: "<invite@example.test>" });
      } else {
        sendMail.mockRejectedValue(
          Object.assign(new Error("smtp_key_invite_test_only"), {
            code: "EAUTH",
          }),
        );
      }
      mocks.createTransport.mockReturnValue({ sendMail, close: vi.fn() });

      const result = await inviteStaffAction(
        null,
        inviteFormData("tech@shop.com"),
      );

      expect(result.emailDeliveryFailed).toBe(!delivered);
      expect(result.token).toMatch(/^inv_[0-9a-f]{48}$/);
      expect(result.inviteUrl).toBe(`/register?invite=${result.token}`);
      expect(result.success).toContain(
        delivered ? "Invitation sent" : "email was not sent",
      );
      expect(mocks.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp-relay.brevo.com",
          port: 587,
          requireTLS: true,
          auth: {
            user: "12345@smtp-brevo.com",
            pass: "smtp_key_invite_test_only",
          },
        }),
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Tracknologia <sender@example.test>",
          to: "tech@shop.com",
          text: expect.stringContaining(result.token!),
        }),
      );
      const repeated = await inviteStaffAction(
        null,
        inviteFormData("tech@shop.com"),
      );
      expect(repeated.reused).toBe(true);
      expect(repeated.token).toBeUndefined();
      expect(sendMail).toHaveBeenCalledTimes(1);
      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .join(" ");
      expect(logged).not.toContain("smtp_key_invite_test_only");
      expect(logged).not.toContain(result.token!);
    },
  );
});
