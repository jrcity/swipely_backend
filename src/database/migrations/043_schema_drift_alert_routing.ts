import type { Knex } from "knex";

/**
 * Seeds a global (owner_address = null) alert routing rule for schema drift
 * alerts raised by SchemaDriftService.checkDrift() via
 * schemaDriftAlerting.service.ts.
 *
 * `owner_address: null` makes this a catch-all rule: AlertRoutingService.listRules()
 * matches rows where owner_address is null OR equal to the alert's ownerAddress,
 * so this rule applies regardless of the synthetic system owner id passed in
 * from the schema drift alerting helper (see config.SCHEMA_DRIFT_ALERT_OWNER).
 *
 * source_types: ["schema_drift"] scopes this rule so it only matches alerts
 * emitted for detected provider response schema drift, not unrelated alert
 * types.
 */
export async function up(knex: Knex): Promise<void> {
  await knex("alert_routing_rules").insert({
    name: "Schema drift (default)",
    owner_address: null,
    severity_levels: JSON.stringify(["critical", "high", "medium", "low"]),
    asset_codes: JSON.stringify([]),
    source_types: JSON.stringify(["schema_drift"]),
    channels: JSON.stringify(["in_app", "webhook"]),
    fallback_channels: JSON.stringify(["in_app"]),
    suppression_window_seconds: 0,
    priority_order: 50,
    is_active: true,
    created_by: "system:migration",
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex("alert_routing_rules")
    .where({ name: "Schema drift (default)", created_by: "system:migration" })
    .delete();
}
