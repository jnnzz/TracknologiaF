import "server-only";
import { getServerConfig } from "@/lib/config/server";
import { createClient } from "@/lib/supabase/server";
import type { LoginInput, RegisterInput } from "./schemas";
import { AuthError } from "./types";

export async function loginWithPassword(credentials: LoginInput) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: credentials.email,
    password: credentials.password,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function registerProviderAccount(
  params: RegisterInput & { emailRedirectTo?: string },
) {
  const supabase = await createClient();
  const config = getServerConfig();

  const { data, error } = await supabase.auth.signUp({
    email: params.email,
    password: params.password,
    options: {
      emailRedirectTo: params.emailRedirectTo,
      data: {
        intent: params.intent,
        provider_type:
          params.intent === "SHOP" || params.intent === "INDEPENDENT"
            ? params.intent
            : undefined,
      },
    },
  });

  if (error) {
    const errorCode = "code" in error ? error.code : undefined;
    if (errorCode === "user_already_exists" || errorCode === "email_exists") {
      throw new AuthError(
        "An account already exists for this email address.",
        "REGISTRATION_CONFLICT",
        error,
      );
    }

    // If Supabase encountered an email delivery failure (e.g. SMTP config / rate limit), check if user was created and can sign in
    const isEmailError =
      error.message.includes("confirmation email") ||
      error.message.includes("rate limit") ||
      error.message.includes("SMTP") ||
      error.status === 429;

    if (isEmailError) {
      try {
        const signInResult = await supabase.auth.signInWithPassword({
          email: params.email,
          password: params.password,
        });

        if (signInResult.data?.session && signInResult.data?.user) {
          return signInResult.data;
        }
      } catch {
        // continue
      }

      if (config.runtime === "production") {
        throw new AuthError(
          "Confirmation email delivery failed. Please try again later or contact support.",
          "EMAIL_DELIVERY_FAILURE",
          error,
        );
      }

      throw new Error(
        "Email delivery failed. If using Custom SMTP, verify the SMTP credentials and sender in Supabase Authentication settings. To skip email verification in development, disable 'Confirm email' in Supabase -> Authentication -> Email.",
      );
    }

    if (config.runtime === "production") {
      console.error("Supabase registration failed", error);
      throw new AuthError(
        "Unable to create your account at this time. Please try again later.",
        "INFRASTRUCTURE_FAILURE",
        error,
      );
    }

    throw new Error(error.message);
  }

  return data;
}

export async function requestPasswordReset(params: {
  email: string;
  redirectTo?: string;
}) {
  const supabase = await createClient();
  const config = getServerConfig();
  const { data, error } = await supabase.auth.resetPasswordForEmail(
    params.email,
    {
      redirectTo: params.redirectTo,
    },
  );

  if (error) {
    // The original Supabase error travels as the cause, so the action can log
    // its status and code while the public answer stays neutral.
    if (config.runtime === "production") {
      throw new AuthError(
        "Unable to send password reset email at this time. Please try again later.",
        "INFRASTRUCTURE_FAILURE",
        error,
      );
    }
    throw new AuthError(error.message, "INFRASTRUCTURE_FAILURE", error);
  }

  return data;
}

export async function resetPassword(params: { newPassword: string }) {
  const supabase = await createClient();
  const config = getServerConfig();
  const { data, error } = await supabase.auth.updateUser({
    password: params.newPassword,
  });

  if (error) {
    if (config.runtime === "production") {
      // Fail closed without exposing Auth internals: the recovery session may
      // be missing, expired, or already used, or the Auth service may be
      // degraded. The reset page directs the visitor back to a fresh
      // recovery request instead.
      throw new Error(
        "Unable to set your password right now. Request a fresh password reset email and try again.",
      );
    }
    throw new Error(error.message);
  }

  return data;
}

export async function signOutUser() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error(error.message);
  }
}
