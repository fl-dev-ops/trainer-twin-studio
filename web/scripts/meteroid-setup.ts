/**
 * Sets up Meteroid for org credits, once per Meteroid environment (sandbox, production); safe to run again.
 *   - credit unit MINS (1 credit = 1 minute of practice);
 *   - usage metric voice_minutes: the sum of `minutes` the app reports (lib/org-credits.ts);
 *   - plan "Credits": no fee, voice minutes spend MINS 1:1. Usage the credits don't cover is billed at
 *     OVERAGE_PER_MINUTE (Meteroid needs a price; the app stops spending at zero, so it shouldn't happen).
 *
 *   bun scripts/meteroid-setup.ts
 */
import { CREDIT_UNIT, meteroid, USAGE_METRIC } from "@/lib/meteroid";

const PLAN = "Credits";
const OVERAGE_PER_MINUTE = "0.25";

type Page<T> = { data?: T[] };
const units = (await meteroid<Page<{ id: string; code: string }>>("GET", "/credit-units")).data ?? [];
const unit = units.find((u) => u.code === CREDIT_UNIT)
  ?? await meteroid<{ id: string }>("POST", "/credit-units", { code: CREDIT_UNIT, name: "minute", plural_name: "minutes", precision: 0 });
const family = (await meteroid<Page<{ id: string }>>("GET", "/product_families")).data?.[0]?.id;
if (!family) throw new Error("Meteroid has no product family; create one in its UI first");

const metrics = (await meteroid<Page<{ id: string; code: string; archived_at?: string | null }>>("GET", "/metrics?per_page=100")).data ?? [];
const metric = metrics.find((m) => m.code === USAGE_METRIC && !m.archived_at)
  ?? await meteroid<{ id: string }>("POST", "/metrics", {
    name: "Voice minutes", code: USAGE_METRIC, aggregation_type: "SUM", aggregation_key: "minutes",
    product_family_id: family, unit_singular: "minute", unit_plural: "minutes",
  });

const plans = (await meteroid<Page<{ id: string; name: string }>>("GET", "/plans?per_page=100")).data ?? [];
const plan = plans.find((p) => p.name === PLAN)
  ?? await meteroid<{ id: string }>("POST", "/plans", {
    name: PLAN, product_family_id: family, plan_type: "STANDARD", status: "ACTIVE", currency: "USD",
    description: "Org credits: practice minutes granted or bought, spent by learners' minutes and team calls",
    components: [
      { name: "Platform fee", fee: { type: "RATE", rates: [{ term: "MONTHLY", price: "0.00" }] } },
      { name: "Voice minutes", fee: { type: "USAGE", metric_id: metric.id, cadence: "MONTHLY", pricing: { type: "PER_UNIT", rate: "1" },
        credit_unit: { credit_unit_id: unit.id, rate: OVERAGE_PER_MINUTE } } },
    ],
  });

console.log(JSON.stringify({ creditUnit: unit.id, metric: metric.id, plan: plan.id }, null, 2));
