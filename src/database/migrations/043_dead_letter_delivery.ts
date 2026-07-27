import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("dead_letter_delivery", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("queue_name", 128).notNullable();
    table.string("job_name", 128).notNullable();
    table.jsonb("payload").notNullable();
    table.integer("attempts").notNullable().defaultTo(0);
    table.text("last_error").nullable();
    table.jsonb("last_response").nullable();
    table.timestamp("failed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamps(true, true);

    table.index(["queue_name", "failed_at"], "idx_dlq_delivery_queue_failed");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("dead_letter_delivery");
}
