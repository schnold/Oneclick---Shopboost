import type { Job } from "bullmq";
import { Prisma } from "@prisma/client";
import prisma from "../../app/db.server";
import type { JobPayloads } from "../../app/lib/queue.server";
import { getSettings } from "../../app/lib/settings.server";
import { getStorefrontUrl } from "../../app/lib/shop-info.server";
import { scanHtml, scoreFindings, type SpeedFinding } from "../../app/lib/speed/scan.server";
import { measurePageSpeed, type PsiResult } from "../../app/lib/speed/pagespeed.server";
import { startJob, finishJob, failJob } from "../../app/lib/jobs.server";

/**
 * Measures the storefront and records what a merchant can act on.
 *
 * This module writes nothing to Shopify. An app cannot edit theme code, so the
 * honest scope is: measure, scan, and hand back the exact changes. Pretending
 * otherwise would be the easiest thing in this app to fake and the most
 * damaging to trust.
 */
export async function speed(job: Job<JobPayloads["speed"]>) {
  const { shopDomain, boostId } = job.data;

  await startJob(job.id!, {
    shopDomain,
    boostId,
    module: "speed",
    label: "Storefront speed",
  });

  try {
    const settings = await getSettings(shopDomain);
    const storefront = await getStorefrontUrl(shopDomain);

    let findings: SpeedFinding[] = [];
    let scanNote: string | null = null;

    if (settings.speed.scanStorefront) {
      try {
        const response = await fetch(storefront, {
          headers: {
            // Identify ourselves honestly; some storefronts vary by agent.
            "User-Agent": "Shopboost/1.0 (+storefront performance scan)",
          },
        });
        if (response.ok) {
          findings = scanHtml(await response.text());
        } else {
          scanNote = `Storefront returned ${response.status}`;
        }
      } catch (error) {
        // A password-protected development store is the usual cause.
        scanNote = `Could not read the storefront: ${(error as Error).message}`;
      }
    }

    await job.updateProgress(30);

    let psi: PsiResult | null = null;
    if (settings.speed.runPageSpeed) {
      psi = await measurePageSpeed(storefront);
    }

    await job.updateProgress(85);

    // The speed score prefers a real Lighthouse number and falls back to the
    // scan. Never invent one: an unmeasurable storefront reports null, and the
    // dashboard renders that as "Not measured".
    const speedScore =
      psi?.mobile ?? (findings.length > 0 || settings.speed.scanStorefront === false
        ? scoreFindings(findings)
        : null);

    await prisma.optimizationItem.create({
      data: {
        jobId: job.id!,
        resourceId: storefront,
        field: "speed.report",
        before: {
          psi: psi ? { mobile: psi.mobile, desktop: psi.desktop } : null,
          findings: findings.length,
        } as Prisma.InputJsonValue,
        after: {
          url: storefront,
          psi,
          findings,
          score: speedScore,
          scanNote,
        } as Prisma.InputJsonValue,
        status: "done",
        reason:
          scanNote ??
          psi?.note ??
          `${findings.length} issue(s) found`,
      },
    });

    // Fold the result into the shop's latest snapshot so the dashboard's speed
    // ring stops saying "Not measured".
    const latest = await prisma.auditSnapshot.findFirst({
      where: { shopDomain },
      orderBy: { createdAt: "desc" },
    });

    if (latest && speedScore !== null) {
      const totals = latest.totals as Prisma.JsonObject;
      await prisma.auditSnapshot.update({
        where: { id: latest.id },
        data: {
          speedScore,
          totals: {
            ...totals,
            psi: psi
              ? {
                  mobile: psi.mobile,
                  desktop: psi.desktop,
                  measuredUrl: psi.measuredUrl,
                  measuredAt: psi.measuredAt,
                }
              : null,
            speedFindings: findings as unknown as Prisma.JsonArray,
          } as Prisma.InputJsonValue,
        },
      });
    }

    await finishJob(job.id!);

    console.log(
      `[speed] ${shopDomain}: ${findings.length} finding(s)` +
        (psi ? `, PSI mobile ${psi.mobile ?? "n/a"} / desktop ${psi.desktop ?? "n/a"}` : ""),
    );

    return { findings: findings.length, psi, score: speedScore };
  } catch (error) {
    await failJob(job.id!, (error as Error).message);
    throw error;
  }
}
