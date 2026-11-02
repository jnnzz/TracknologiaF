import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createPublicOperationClient: vi.fn(),
  from: vi.fn(),
  headerGet: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: mocks.headerGet })),
}));

vi.mock("next/server", () => ({ after: mocks.after }));

vi.mock("@/lib/supabase/service", () => ({
  createPublicOperationClient: mocks.createPublicOperationClient,
}));

import { submitRepairRequestAction } from "@/app/(public)/p/[providerSlug]/request/actions";
import { trackRepairAction } from "@/app/(public)/track/actions";

const CLIENT_IP = "203.0.113.10";
const HMAC_SECRET = "production-hmac-secret-with-32-characters";
const PROXY_SECRET = "production-proxy-proof-with-32-characters";
const TRACKING_CODE = "TRK-0123456789ABCDEF01234567";

function trackingFormData() {
  const formData = new FormData();
  formData.set("trackingCode", TRACKING_CODE);
  return formData;
}

function repairRequestFormData() {
  const formData = new FormData();
  formData.set("customerName", "Taylor Customer");
  formData.set("customerPhone", "+1 555 0100");
  formData.set("deviceType", "Phone");
  formData.set("reportedProblem", "The screen no longer turns on");
  return formData;
}

function expectOpaqueRateLimitCall(
  operation: "tracking_lookup" | "repair_request_submit",
  policy: { max: number; windowSeconds: number },
) {
  expect(mocks.rpc).toHaveBeenCalledWith("check_public_operation_rate_limit", {
    p_operation: operation,
    p_actor_key: expect.stringMatching(/^[0-9a-f]{64}$/),
    p_window_seconds: policy.windowSeconds,
    p_max_requests: policy.max,
    p_cleanup_limit: 100,
  });
  expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(CLIENT_IP);
}

beforeEach(() => {
  vi.resetAllMocks();

  vi.stubEnv("NODE_ENV", "production");
  process.env.APP_ENV = "production";
  process.env.NEXT_PUBLIC_APP_URL = "https://tracknologia.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_production_test_key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-production-test-key";
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_USER = "project@gmail.com";
  process.env.SMTP_PASSWORD = "smtp-production-test-password";
  process.env.EMAIL_FROM = "Tracknologia <project@gmail.com>";
  process.env.PUBLIC_ABUSE_HMAC_SECRET = HMAC_SECRET;
  process.env.PUBLIC_ABUSE_TRUSTED_PROXY_SECRET = PROXY_SECRET;
  process.env.NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION = "true";
  delete process.env.PUBLIC_ABUSE_SHARED_DEV_BUCKET;
  delete process.env.PUBLIC_ABUSE_TRACKING_LOOKUP_MAX;
  delete process.env.PUBLIC_ABUSE_TRACKING_LOOKUP_WINDOW_SECONDS;
  delete process.env.PUBLIC_ABUSE_REPAIR_REQUEST_MAX;
  delete process.env.PUBLIC_ABUSE_REPAIR_REQUEST_WINDOW_SECONDS;

  mocks.headerGet.mockImplementation((name: string) => {
    if (name === "x-tracknologia-proxy-secret") return PROXY_SECRET;
    if (name === "x-tracknologia-client-ip") return CLIENT_IP;
    return null;
  });

  mocks.createPublicOperationClient.mockResolvedValue({
    from: mocks.from,
    rpc: mocks.rpc,
  });

  mocks.from.mockReturnValue({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle: mocks.maybeSingle })),
    })),
  });

  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: "790f9800-cf01-4f49-81c1-478239f41f3c",
      provider_type: "SHOP",
      display_name: "Downtown Repair",
      slug: "downtown-repair",
      description: null,
      profile_image_url: null,
      public_address: "10 Main Street",
      service_area: null,
      supported_devices: ["Phone"],
      service_modes: [{ mode: "DROP_OFF", details: null }],
      accepting_requests: true,
      created_at: "2026-08-29T00:00:00.000Z",
    },
    error: null,
  });

  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "check_public_operation_rate_limit") {
      return {
        data: [{ allowed: true, retry_after_seconds: 0 }],
        error: null,
      };
    }
    if (name === "lookup_public_repair") {
      return {
        data: [
          {
            provider_display_name: "Downtown Repair",
            device_type: "Phone",
            brand: "Example",
            model: "One",
            current_status: "IN_PROGRESS",
            service_mode: "DROP_OFF",
            last_updated_at: "2026-08-29T00:00:00.000Z",
            customer_updates: [],
            tracking_type: "REPAIR",
            reference_code: TRACKING_CODE,
            reported_problem: "The screen no longer turns on",
            submitted_at: "2026-08-28T23:00:00.000Z",
          },
        ],
        error: null,
      };
    }
    if (name === "submit_repair_request") {
      return {
        data: [
          {
            reference_code: "REQ-0123456789ABCDEF",
            submitted_at: "2026-08-29T01:00:00.000Z",
          },
        ],
        error: null,
      };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public actions under validated production ingress", () => {
  it("looks up Tracking through trusted ingress and durable abuse control", async () => {
    await expect(trackRepairAction(null, trackingFormData())).resolves.toEqual({
      outcome: "found",
      view: expect.objectContaining({
        trackingCode: TRACKING_CODE,
        providerDisplayName: "Downtown Repair",
        currentStatus: "IN_PROGRESS",
      }),
    });

    expectOpaqueRateLimitCall("tracking_lookup", {
      max: 30,
      windowSeconds: 60,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("lookup_public_repair", {
      p_tracking_code: TRACKING_CODE,
    });
  });

  it("submits a Repair Request through trusted ingress and durable abuse control", async () => {
    await expect(
      submitRepairRequestAction(
        "downtown-repair",
        null,
        repairRequestFormData(),
      ),
    ).resolves.toEqual({
      receipt: {
        referenceCode: "REQ-0123456789ABCDEF",
        submittedAt: "2026-08-29T01:00:00.000Z",
      },
    });

    expectOpaqueRateLimitCall("repair_request_submit", {
      max: 5,
      windowSeconds: 600,
    });
    expect(mocks.from).toHaveBeenCalledWith("public_provider_profiles");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "submit_repair_request",
      expect.objectContaining({
        p_provider_slug: "downtown-repair",
        p_customer_name: "Taylor Customer",
        p_device_type: "Phone",
      }),
    );
  });

  it("does not reach either public feature when ingress proof is absent", async () => {
    mocks.headerGet.mockImplementation((name: string) =>
      name === "x-tracknologia-client-ip" ? CLIENT_IP : null,
    );

    await expect(trackRepairAction(null, trackingFormData())).resolves.toEqual({
      outcome: "unavailable",
      message: "Tracking is temporarily unavailable. Please try again later.",
    });
    await expect(
      submitRepairRequestAction(
        "downtown-repair",
        null,
        repairRequestFormData(),
      ),
    ).resolves.toEqual({
      error: "Unable to submit this Repair Request. Please try again.",
    });

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("looks up Tracking through Vercel's visitor IP without a proxy secret", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("PUBLIC_ABUSE_CLIENT_IP_SOURCE", "vercel");
    delete process.env.PUBLIC_ABUSE_TRUSTED_PROXY_SECRET;
    mocks.headerGet.mockImplementation((name: string) =>
      name === "x-vercel-forwarded-for" ? `${CLIENT_IP}, 10.0.0.1` : null,
    );

    await expect(trackRepairAction(null, trackingFormData())).resolves.toEqual({
      outcome: "found",
      view: expect.objectContaining({
        trackingCode: TRACKING_CODE,
        providerDisplayName: "Downtown Repair",
      }),
    });

    expectOpaqueRateLimitCall("tracking_lookup", {
      max: 30,
      windowSeconds: 60,
    });
  });
});
