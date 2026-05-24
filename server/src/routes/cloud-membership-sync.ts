import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships } from "@paperclipai/db";
import { HUMAN_COMPANY_MEMBERSHIP_ROLES } from "@paperclipai/shared";
import { badRequest, notFound, unauthorized } from "../errors.js";
import { accessService } from "../services/index.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
} from "../services/company-member-roles.js";

const syncMembershipsSchema = z.object({
  action: z.enum(["upsert", "archive"]).default("upsert"),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string().min(1).optional().nullable(),
  }),
  memberships: z
    .array(
      z.object({
        companyId: z.string().min(1).optional(),
        stackId: z.string().min(1).optional(),
        companyName: z.string().min(1).optional().nullable(),
        role: z.enum(HUMAN_COMPANY_MEMBERSHIP_ROLES).optional(),
      }).refine((value) => Boolean(value.companyId || value.stackId), {
        message: "companyId or stackId is required",
      }),
    )
    .min(1),
});

export function cloudMembershipSyncRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.post("/cloud/memberships/sync", async (req, res) => {
    assertTrustedCloudSyncRequest(req.header("x-paperclip-cloud-tenant-token"));
    const payload = syncMembershipsSchema.parse(req.body);
    const now = new Date();
    const userName = payload.user.name?.trim() || payload.user.email;
    const userEmail = payload.user.email.trim().toLowerCase();

    if (payload.action === "upsert") {
      await db
        .insert(authUsers)
        .values({
          id: payload.user.id,
          name: userName,
          email: userEmail,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: authUsers.id,
          set: {
            name: userName,
            email: userEmail,
            emailVerified: true,
            updatedAt: now,
          },
        });
    }

    const synced = [];
    for (const membership of payload.memberships) {
      const role = normalizeHumanRole(membership.role, "operator");
      const companyId = membership.companyId?.trim() || cloudTenantCompanyId(membership.stackId!.trim());
      const companyName =
        membership.companyName?.trim() ||
        (membership.stackId ? `${membership.stackId.trim()} Paperclip` : null);

      if (membership.stackId && payload.action === "upsert") {
        const stackId = membership.stackId.trim();
        await db
          .insert(companies)
          .values({
            id: companyId,
            name: companyName || `${stackId} Paperclip`,
            description: `Provisioned by Paperclip Cloud for stack ${stackId}.`,
            status: "active",
            issuePrefix: issuePrefixForCloudStack(stackId),
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: companies.id,
          });
      } else {
        const existing = await db
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Company not found");
      }

      if (payload.action === "archive") {
        const member = await db
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, payload.user.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!member) {
          synced.push({
            companyId,
            membershipId: null,
            membershipRole: null,
            status: "not_found",
          });
          continue;
        }
        const result = await access.archiveMember(companyId, member.id);
        synced.push({
          companyId,
          membershipId: result?.member.id ?? member.id,
          membershipRole: result?.member.membershipRole ?? member.membershipRole,
          status: result?.member.status ?? member.status,
        });
        continue;
      }

      const member = await access.ensureMembership(companyId, "user", payload.user.id, role, "active");
      await access.setPrincipalGrants(companyId, "user", payload.user.id, grantsForHumanRole(role), null);
      synced.push({
        companyId,
        membershipId: member.id,
        membershipRole: member.membershipRole,
        status: member.status,
      });
    }

    res.json({ ok: true, userId: payload.user.id, memberships: synced });
  });

  return router;
}

function assertTrustedCloudSyncRequest(token: string | undefined) {
  const expected = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  const actual = token?.trim();
  if (!expected) throw badRequest("Cloud tenant sync is not configured");
  if (!actual || !constantTimeStringEqual(actual, expected)) {
    throw unauthorized("Invalid cloud tenant token");
  }
}

function constantTimeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}
