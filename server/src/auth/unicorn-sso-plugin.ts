import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";

type UnicornSsoExchangeResponse = {
  userId: string;
  email: string;
  name: string;
  role: string;
  companyId: string;
  companyName: string;
};

type UnicornInstancePrivateJwk = {
  kty?: string;
  crv?: string;
  kid?: string;
  d?: string;
};

const unicornSsoQuerySchema = z.object({
  token: z.string().min(1),
  next: z.string().optional(),
});

export function unicornSsoPlugin(): BetterAuthPlugin {
  return {
    id: "unicorn-sso",
    endpoints: {
      unicornSso: createAuthEndpoint(
        "/unicorn/sso",
        {
          method: "GET",
          query: unicornSsoQuerySchema,
        },
        async (ctx) => {
          const exchanged = await exchangeUnicornSsoToken(ctx.query.token);
          const email = exchanged.email.trim().toLowerCase();
          const name = exchanged.name?.trim() || email;

          const existingById = await ctx.context.internalAdapter.findUserById(exchanged.userId);
          const existingByEmail = existingById ? null : await ctx.context.internalAdapter.findUserByEmail(email);
          const user = existingById
            ? await ctx.context.internalAdapter.updateUser(existingById.id, {
                email,
                name,
                emailVerified: true,
              })
            : existingByEmail?.user?.id
              ? await ctx.context.internalAdapter.updateUser(existingByEmail.user.id, {
                  name,
                  emailVerified: true,
                })
              : await ctx.context.internalAdapter.createUser({
                  id: exchanged.userId,
                  email,
                  name,
                  emailVerified: true,
                });
          const session = await ctx.context.internalAdapter.createSession(user.id);

          await setSessionCookie(ctx, {
            session,
            user,
          });

          return Response.redirect(resolveSafeRedirect(ctx.query.next, ctx.context.baseURL));
        },
      ),
    },
  };
}

async function exchangeUnicornSsoToken(token: string): Promise<UnicornSsoExchangeResponse> {
  const apiBaseUrl = requiredEnv("UNICORN_API_BASE_URL").replace(/\/+$/g, "");
  const instanceId = requiredEnv("UNICORN_INSTANCE_ID");

  const response = await fetch(`${apiBaseUrl}/tenant-sso/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signInstanceJwt()}`,
    },
    body: JSON.stringify({
      token,
      instanceId,
    }),
  });

  if (!response.ok) {
    throw new APIError("UNAUTHORIZED", {
      message: "Invalid or expired UnicornOne SSO token",
    });
  }

  const body = await response.json() as Partial<UnicornSsoExchangeResponse>;
  if (!body.userId || !body.email) {
    throw new APIError("UNAUTHORIZED", {
      message: "UnicornOne SSO exchange did not return a valid user",
    });
  }

  return {
    userId: body.userId,
    email: body.email,
    name: body.name ?? body.email,
    role: body.role ?? "member",
    companyId: body.companyId ?? "",
    companyName: body.companyName ?? "",
  };
}

function signInstanceJwt() {
  const instanceId = requiredEnv("UNICORN_INSTANCE_ID");
  const companyId = requiredEnv("UNICORN_COMPANY_ID");
  const privateJwk = parseInstancePrivateJwk();
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = {
    alg: "EdDSA",
    typ: "JWT",
  };
  const keyVersion = process.env.UNICORN_INSTANCE_KEY_VERSION?.trim();
  if (privateJwk.kid) header.kid = privateJwk.kid;
  else if (keyVersion) header.kid = keyVersion;

  const payload = {
    iss: "unicorn-instance",
    aud: "unicorn-control-plane",
    sub: instanceId,
    instanceId,
    companyId,
    iat: now,
    exp: now + 60,
    jti: randomBytes(18).toString("base64url"),
  };

  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const key = createPrivateKey({
    key: privateJwk,
    format: "jwk",
  });
  const signature = sign(null, Buffer.from(unsigned), key).toString("base64url");
  return `${unsigned}.${signature}`;
}

function parseInstancePrivateJwk(): UnicornInstancePrivateJwk {
  const raw =
    process.env.UNICORN_INSTANCE_PRIVATE_KEY_JWK?.trim() ||
    decodeBase64UrlEnv(process.env.UNICORN_INSTANCE_PRIVATE_KEY_JWK_B64);
  if (!raw) {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "UNICORN_INSTANCE_PRIVATE_KEY_JWK is not configured",
    });
  }

  try {
    const jwk = JSON.parse(raw) as UnicornInstancePrivateJwk;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) {
      throw new Error("invalid instance key");
    }
    return jwk;
  } catch {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "UNICORN_INSTANCE_PRIVATE_KEY_JWK must be an Ed25519 private JWK",
    });
  }
}

function decodeBase64UrlEnv(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    return Buffer.from(trimmed, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: `${name} is not configured`,
    });
  }
  return value;
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function resolveSafeRedirect(value: string | undefined, baseUrl: string) {
  const fallback = new URL("/", baseUrl);
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }
  try {
    return new URL(trimmed, baseUrl);
  } catch {
    return fallback;
  }
}
