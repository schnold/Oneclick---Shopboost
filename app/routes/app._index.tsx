import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { getDashboardData, enqueueAudit, getBoostProgress } from "../lib/boost.server";
import {
  startBoost,
  NoAuditError,
  BoostInProgressError,
  NotEntitledError,
} from "../lib/boost-orchestrator.server";
import { getEntitlement } from "../lib/billing.server";
import { embedActivationUrl } from "../lib/geo/embed.server";
import prisma from "../db.server";
import type { SpeedFinding } from "../lib/speed/scan.server";
import { getSettings } from "../lib/settings.server";
import { formatBytes } from "../lib/format";
import type { IconName } from "../lib/icons";
import { ScoreRing } from "../components/ScoreRing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [dashboard, settings, boost, entitlement, embedUrl] = await Promise.all([
    getDashboardData(session.shop),
    getSettings(session.shop),
    getBoostProgress(session.shop),
    getEntitlement(session.shop),
    embedActivationUrl(session.shop),
  ]);

  // Drafted FAQs sit in review until approved; without a pointer here the
  // default "review before publishing" setting looks like nothing happened.
  const pendingFaqs = await prisma.optimizationItem.count({
    where: {
      job: { shopDomain: session.shop },
      field: "geo.faq.pending",
      status: "done",
    },
  });

  return {
    dashboard,
    settings,
    boost,
    entitlement,
    embedUrl,
    pendingFaqs,
    shop: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "audit") {
    await enqueueAudit(session.shop, "scheduled");
    return { ok: true, message: "Scanning your shop…" };
  }

  if (intent === "boost") {
    try {
      const plan = await startBoost(session.shop);
      return {
        ok: true,
        message:
          plan.total === 0
            ? "Nothing to optimize — your shop is already in good shape."
            : `Optimizing ${plan.total.toLocaleString()} items…`,
      };
    } catch (error) {
      if (
        error instanceof NoAuditError ||
        error instanceof BoostInProgressError ||
        error instanceof NotEntitledError
      ) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  return { ok: false, message: "Unknown action" };
};

export default function Dashboard() {
  const { dashboard, settings, boost, entitlement, embedUrl, pendingFaqs } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const submitting = navigation.state === "submitting";
  const waitingForAudit = !dashboard.hasAudit;
  const boosting = boost.running;

  // Poll while anything is in flight: the first audit, or a running boost.
  // Polling stops on its own once both have settled.
  useEffect(() => {
    if (!waitingForAudit && !boosting) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(id);
  }, [waitingForAudit, boosting, revalidator]);

  const { current, potential, totals } = dashboard;
  const speedFindings: SpeedFinding[] =
    (totals as { speedFindings?: SpeedFinding[] } | null)?.speedFindings ?? [];
  const enabledModules = Object.entries(settings.modules)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const overallGain =
    current && potential ? Math.max(0, potential.boostScore - current.boostScore) : 0;

  // The outcome each module delivers, in the merchant's words. These caption
  // the rings and the summary chips, so a merchant reads what they get —
  // "compressed", "faster" — rather than a bare number of points.
  const gains =
    current && potential
      ? ([
          { key: "images", word: "compressed", gain: potential.imageScore - current.imageScore },
          { key: "seo", word: "searchable", gain: potential.seoScore - current.seoScore },
          { key: "geo", word: "quotable", gain: potential.geoScore - current.geoScore },
          {
            key: "speed",
            word: "faster",
            // Speed is unmeasured until the first boost, and an unmeasured
            // module has no honest gain to advertise.
            gain: dashboard.speedMeasured
              ? potential.speedScore - current.speedScore
              : 0,
          },
        ] as const)
      : [];
  const wins = gains.filter((g) => g.gain > 0);

  return (
    <s-page heading="Shopboost">
      <Form method="post" slot="primary-action">
        <input type="hidden" name="intent" value="boost" />
        <s-button
          type="submit"
          variant="primary"
          icon="rocket"
          loading={submitting || boosting}
          disabled={
            !dashboard.hasAudit ||
            enabledModules.length === 0 ||
            boosting ||
            !entitlement.canBoost
          }
        >
          {boosting ? "Boosting…" : "Boost shop"}
        </s-button>
      </Form>

      {entitlement.blockedReason && dashboard.hasAudit && (
        <s-banner tone="info">
          <s-stack direction="block" gap="small">
            <s-text>{entitlement.blockedReason}</s-text>
            <s-link href="/app/billing">See plans</s-link>
          </s-stack>
        </s-banner>
      )}

      {actionData?.message && (
        <s-banner tone={actionData.ok ? "success" : "warning"} dismissible>
          {actionData.message}
        </s-banner>
      )}

      {(boosting || boost.settled > 0) && (
        <BoostPanel boost={boost} dashboard={dashboard} />
      )}

      {waitingForAudit ? (
        <s-section heading="Scanning your shop">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-spinner />
              <s-text>
                Reading your catalog and measuring what can be improved. This usually
                takes a minute or two.
              </s-text>
            </s-stack>
            <s-text color="subdued">
              The scan runs in the background — you can leave this page and come back.
            </s-text>
            <Form method="post">
              <input type="hidden" name="intent" value="audit" />
              <s-button type="submit" icon="refresh" loading={submitting}>
                Scan again
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      ) : (
        <>
          <s-section heading="Optimization potential">
            <s-stack direction="block" gap="large">
              {/* The overall score leads: it is a summary of the four below it,
                  not a fifth peer, and a five-up grid left a hole anyway. */}
              <s-grid
                gridTemplateColumns="auto minmax(0, 1fr)"
                gap="large"
                alignItems="center"
              >
                <ScoreRing
                  label="Overall"
                  icon="target"
                  score={current!.boostScore}
                  potential={potential!.boostScore}
                  size={168}
                  gainWord="better"
                  // The gain is already the heading beside it; the scan time is
                  // the fact that is otherwise buried at the foot of the page.
                  caption={
                    dashboard.measuredAt
                      ? `Scanned ${new Date(dashboard.measuredAt).toLocaleDateString()}`
                      : undefined
                  }
                />
                <s-stack direction="block" gap="base">
                  {overallGain > 0 ? (
                    <>
                      <s-stack direction="inline" gap="small-300" alignItems="center">
                        <s-icon type="arrow-up" tone="success" size="small" />
                        <s-heading>
                          +{overallGain}% better shop, one press away
                        </s-heading>
                      </s-stack>

                      {wins.length > 0 && (
                        // A grid, not an inline stack: s-stack has no wrap
                        // control, and four chips overflow this column beside
                        // the ring at narrow widths.
                        <s-grid
                          gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))"
                          gap="small-300"
                        >
                          {wins.map((win) => (
                            <s-badge key={win.key} tone="success" icon="arrow-up">
                              +{win.gain}% {win.word}
                            </s-badge>
                          ))}
                        </s-grid>
                      )}

                      <s-text color="subdued">
                        Each ring shows where your shop stands today. The green arc
                        is the ground a boost wins — press Boost shop and every
                        change is recorded, reversible, and visible in History.
                      </s-text>
                    </>
                  ) : (
                    <>
                      <s-stack direction="inline" gap="small-300" alignItems="center">
                        <s-icon type="check-circle" tone="success" size="small" />
                        <s-heading>Your shop is fully optimized</s-heading>
                      </s-stack>
                      <s-text color="subdued">
                        Every ring is at 100%. Rescan after you add products and
                        Shopboost will show you what is new to win.
                      </s-text>
                    </>
                  )}
                </s-stack>
              </s-grid>

              <s-divider />

              {/* Fixed 2x2 rather than auto-fit: with exactly four rings, any
                  column count other than 2 or 4 leaves an orphan on the last
                  row, and the aside keeps this column too narrow for 4. */}
              <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="large">
                <ScoreRing
                  label="Images"
                  icon="image"
                  score={current!.imageScore}
                  potential={potential!.imageScore}
                  gainWord="compressed"
                />
                <ScoreRing
                  label="SEO"
                  icon="search"
                  score={current!.seoScore}
                  potential={potential!.seoScore}
                  gainWord="searchable"
                />
                <ScoreRing
                  label="GEO"
                  icon="iq"
                  score={current!.geoScore}
                  potential={potential!.geoScore}
                  gainWord="quotable"
                />
                <ScoreRing
                  label="Speed"
                  icon="gauge"
                  score={dashboard.speedMeasured ? current!.speedScore : null}
                  potential={dashboard.speedMeasured ? potential!.speedScore : null}
                  gainWord="faster"
                  caption={dashboard.speedMeasured ? undefined : "Measured on first boost"}
                />
              </s-grid>
            </s-stack>
          </s-section>

          <s-section heading="What a boost would change">
            <s-stack direction="block" gap="base">
              <s-table>
                <s-table-header-row>
                  <s-table-header>Opportunity</s-table-header>
                  <s-table-header format="numeric">Found</s-table-header>
                  <s-table-header>Effect</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  <OpportunityRow
                    label="Images to recompress"
                    icon="image"
                    count={totals!.imagesOverweight}
                    effect={
                      totals!.recoverableBytes > 0
                        ? `${formatBytes(totals!.recoverableBytes)} smaller`
                        : "Nothing to reclaim"
                    }
                  />
                  <OpportunityRow
                    label="Products missing or weak metas"
                    icon="search"
                    count={totals!.productsWithSeoIssues}
                    effect="Search titles and descriptions written"
                  />
                  <OpportunityRow
                    label="Images without alt text"
                    icon="image-alt"
                    count={totals!.mediaMissingAlt}
                    effect="Accessibility and image search"
                  />
                  <OpportunityRow
                    label="Products with thin descriptions"
                    icon="text"
                    count={totals!.productsThinDescription}
                    effect="Content AI answer engines can quote"
                  />
                </s-table-body>
              </s-table>

              <s-text color="subdued">
                Scanned {totals!.productCount.toLocaleString()} products and{" "}
                {totals!.imageCount.toLocaleString()} images, totalling{" "}
                {formatBytes(totals!.imageBytes)}.
                {dashboard.measuredAt
                  ? ` Last scan ${new Date(dashboard.measuredAt).toLocaleString()}.`
                  : ""}
              </s-text>

              <Form method="post">
                <input type="hidden" name="intent" value="audit" />
                <s-button type="submit" icon="refresh" loading={submitting}>
                  Rescan
                </s-button>
              </Form>
            </s-stack>
          </s-section>
        </>
      )}

      {pendingFaqs > 0 && (
        <s-banner tone="info">
          <s-stack direction="block" gap="small">
            <s-text>
              {pendingFaqs} product{pendingFaqs === 1 ? " has" : "s have"} FAQ answers
              waiting for your review. Nothing is published until you approve them.
            </s-text>
            <s-link href="/app/faqs">Review them</s-link>
          </s-stack>
        </s-banner>
      )}

      {settings.modules.geo && embedUrl && dashboard.hasAudit && (
        <s-section heading="Turn on structured data">
          <s-stack direction="block" gap="base">
            <s-text>
              Structured data is added by a block in your theme. Shopify requires you
              to switch it on yourself — apps are not allowed to do it for you.
            </s-text>
            <s-text color="subdued">
              The link below opens your theme editor with the Shopboost block already
              enabled. Press Save there and your product pages start describing
              themselves to Google, ChatGPT and Perplexity.
            </s-text>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-icon type="theme-edit" tone="neutral" size="small" />
              <s-link href={embedUrl} target="_top">
                Open theme editor and enable Shopboost
              </s-link>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {speedFindings.length > 0 && (
        <s-section heading="Storefront speed — fixes for your theme">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              These live in your theme, so Shopboost cannot change them for you. Each
              one names the exact edit.
            </s-text>
            {speedFindings.map((finding) => (
              <s-box
                key={finding.id}
                padding="base"
                borderRadius="base"
                borderWidth="base"
                borderColor="subdued"
              >
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone={severityTone(finding.severity)}>
                      {finding.impact}
                    </s-badge>
                    <s-text type="strong">{finding.title}</s-text>
                    {finding.count > 1 && (
                      <s-text color="subdued">×{finding.count}</s-text>
                    )}
                  </s-stack>
                  <s-text color="subdued">{finding.detail}</s-text>
                  <s-stack direction="inline" gap="small-300" alignItems="start">
                    <s-icon type="wrench" tone="neutral" size="small" />
                    <s-text>{finding.fix}</s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Modules">
        <s-stack direction="block" gap="small">
          <ModuleRow name="Images" icon="image" on={settings.modules.images} />
          <ModuleRow name="SEO" icon="search" on={settings.modules.seo} />
          <ModuleRow name="GEO" icon="iq" on={settings.modules.geo} />
          <ModuleRow name="Speed" icon="gauge" on={settings.modules.speed} />
          <s-divider />
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-icon type="plan" tone="neutral" size="small" />
              <s-text>Plan</s-text>
            </s-stack>
            <s-badge tone={entitlement.plan === "free" ? "auto" : "success"}>
              {entitlement.planName}
            </s-badge>
          </s-stack>
          <s-divider />
          <s-stack direction="block" gap="small-200">
            <s-link href="/app/settings">Adjust settings</s-link>
            <s-link href="/app/billing">Manage plan</s-link>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/**
 * The before/after story: live progress while the boost runs, then the measured
 * result once the "after" scan lands.
 */
function BoostPanel({
  boost,
  dashboard,
}: {
  boost: Awaited<ReturnType<typeof getBoostProgress>>;
  dashboard: Awaited<ReturnType<typeof getDashboardData>>;
}) {
  const pct = boost.total > 0 ? Math.round((boost.settled / boost.total) * 100) : 0;
  const measured = boost.before && boost.after;

  return (
    <s-section heading={boost.running ? "Boosting your shop" : "Last boost"}>
      <s-stack direction="block" gap="base">
        {boost.running ? (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-spinner />
            <s-text>
              {boost.settled.toLocaleString()} of {boost.total.toLocaleString()} done
              {pct > 0 ? ` · ${pct}%` : ""}
            </s-text>
            <s-link href="/app/queue">View queue</s-link>
          </s-stack>
        ) : (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={boost.failed > 0 ? "caution" : "success"}>
              {boost.failed > 0 ? `${boost.failed} failed` : "Complete"}
            </s-badge>
            <s-text color="subdued">
              {boost.settled.toLocaleString()} items processed
            </s-text>
          </s-stack>
        )}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="large">
          <BeforeAfter
            label="Image weight removed"
            icon="image"
            value={formatBytes(boost.savedBytes)}
            detail={
              boost.savedBytes > 0
                ? "measured from the files we replaced"
                : "nothing reclaimed yet"
            }
          />
          <BeforeAfter
            label="Overall score"
            icon="target"
            value={
              measured
                ? `${boost.before!.boostScore} → ${boost.after!.boostScore}`
                : `${dashboard.current?.boostScore ?? "—"}`
            }
            detail={measured ? "before → after" : "rescanning after the boost…"}
          />
          <BeforeAfter
            label="Image score"
            icon="chart-line"
            value={
              measured
                ? `${boost.before!.imageScore} → ${boost.after!.imageScore}`
                : `${dashboard.current?.imageScore ?? "—"}`
            }
            detail={measured ? "before → after" : "rescanning after the boost…"}
          />
        </s-grid>

        {!boost.running && (
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-icon type="clock-revert" tone="neutral" size="small" />
            <s-link href="/app/history">
              See every change, and undo any of them
            </s-link>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

function BeforeAfter({
  label,
  icon,
  value,
  detail,
}: {
  label: string;
  icon: IconName;
  value: string;
  detail: string;
}) {
  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
      borderColor="subdued"
    >
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-icon type={icon} tone="neutral" size="small" />
          <s-text color="subdued">{label}</s-text>
        </s-stack>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{detail}</s-text>
      </s-stack>
    </s-box>
  );
}

function OpportunityRow({
  label,
  icon,
  count,
  effect,
}: {
  label: string;
  icon: IconName;
  count: number;
  effect: string;
}) {
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-icon type={icon} tone="neutral" size="small" />
          <s-text>{label}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={count > 0 ? "caution" : "success"}>
          {count.toLocaleString()}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-text color="subdued">{count > 0 ? effect : "Already clean"}</s-text>
      </s-table-cell>
    </s-table-row>
  );
}

function ModuleRow({
  name,
  icon,
  on,
}: {
  name: string;
  icon: IconName;
  on: boolean;
}) {
  return (
    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-icon type={icon} tone={on ? "success" : "neutral"} size="small" />
        <s-text>{name}</s-text>
      </s-stack>
      <s-badge tone={on ? "success" : "auto"}>{on ? "On" : "Off"}</s-badge>
    </s-stack>
  );
}

// Annotated, not inferred: an unannotated return widens to `string`, which
// `s-badge`'s `tone` rejects at build time.
function severityTone(
  severity: SpeedFinding["severity"],
): "critical" | "warning" | "info" {
  return severity === "high" ? "critical" : severity === "medium" ? "warning" : "info";
}
