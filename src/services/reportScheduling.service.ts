import crypto from "crypto";
import { getDatabase } from "../database/connection.js";
import { logger } from "../utils/logger.js";
import { EmailNotificationService, EmailRecipient, EmailReportPayload } from "./email.service.js";
import { AnalyticsService } from "./analytics.service.js";
import { AlertService } from "./alert.service.js";
import { ReconciliationService } from "./reconciliation.service.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export type ReportFrequency = "daily" | "weekly";
export type ReportStatus = "pending" | "sent" | "failed" | "skipped";

export interface ReportSchedule {
  id: string;
  templateId: string;
  frequency: ReportFrequency;
  userAddress: string;
  email: string;
  timezone: string;
  preferredHour: number; // 0-23
  preferredDayOfWeek?: number; // 0-6, required for weekly
  quietHours: { start: number; end: number };
  destinations: string[]; // e.g., ["email", "slack"]
  isActive: boolean;
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportDelivery {
  id: string;
  scheduleId: string;
  frequency: ReportFrequency;
  userAddress: string;
  email: string;
  periodStart: Date;
  periodEnd: Date;
  status: ReportStatus;
  attempts: number;
  sentAt: Date | null;
  nextRetryAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MINUTES = 30;
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_PREFERRED_HOUR = 9; // 9 AM

// =============================================================================
// REPORT SCHEDULING SERVICE
// =============================================================================

export class ReportSchedulingService {
  private static instance: ReportSchedulingService;
  private emailService: EmailNotificationService;
  private analyticsService: AnalyticsService;
  private alertService: AlertService;
  private reconciliationService: ReconciliationService;

  private constructor() {
    this.emailService = new EmailNotificationService();
    this.analyticsService = new AnalyticsService();
    this.alertService = new AlertService();
    this.reconciliationService = new ReconciliationService();
  }

  public static getInstance(): ReportSchedulingService {
    if (!ReportSchedulingService.instance) {
      ReportSchedulingService.instance = new ReportSchedulingService();
    }
    return ReportSchedulingService.instance;
  }

  // ---------------------------------------------------------------------------
  // SCHEDULE MANAGEMENT
  // ---------------------------------------------------------------------------

  /** Create a new report schedule */
  public async createSchedule(params: {
    templateId: string;
    frequency: ReportFrequency;
    userAddress: string;
    email: string;
    timezone?: string;
    preferredHour?: number;
    preferredDayOfWeek?: number;
    quietHours?: { start: number; end: number };
    destinations?: string[];
    dailyEnabled?: boolean;
    weeklyEnabled?: boolean;
  }): Promise<ReportSchedule> {
    const db = getDatabase();
    const now = new Date();
    const schedule: ReportSchedule = {
      id: crypto.randomUUID(),
      templateId: params.templateId,
      frequency: params.frequency,
      userAddress: params.userAddress,
      email: params.email,
      timezone: params.timezone ?? DEFAULT_TIMEZONE,
      preferredHour: params.preferredHour ?? DEFAULT_PREFERRED_HOUR,
      preferredDayOfWeek: params.preferredDayOfWeek,
      quietHours: params.quietHours ?? { start: 22, end: 7 },
      destinations: params.destinations ?? ["email"],
      isActive: true,
      dailyEnabled: params.dailyEnabled ?? true,
      weeklyEnabled: params.weeklyEnabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    await db("report_schedules").insert({
      id: schedule.id,
      template_id: schedule.templateId,
      frequency: schedule.frequency,
      user_address: schedule.userAddress,
      email: schedule.email,
      timezone: schedule.timezone,
      preferred_hour: schedule.preferredHour,
      preferred_day_of_week: schedule.preferredDayOfWeek,
      quiet_hours: JSON.stringify(schedule.quietHours),
      destinations: JSON.stringify(schedule.destinations),
      is_active: schedule.isActive,
      daily_enabled: schedule.dailyEnabled,
      weekly_enabled: schedule.weeklyEnabled,
      created_at: now,
      updated_at: now,
    });
    logger.info({ scheduleId: schedule.id }, "Report schedule created");
    return schedule;
  }

  /** Update an existing schedule */
  public async updateSchedule(
    scheduleId: string,
    updates: Partial<Omit<ReportSchedule, "id" | "createdAt" | "updatedAt">>,
  ): Promise<ReportSchedule> {
    const db = getDatabase();
    const updateData: any = { updated_at: new Date() };
    if (updates.frequency !== undefined) updateData.frequency = updates.frequency;
    if (updates.timezone !== undefined) updateData.timezone = updates.timezone;
    if (updates.preferredHour !== undefined) updateData.preferred_hour = updates.preferredHour;
    if (updates.preferredDayOfWeek !== undefined) updateData.preferred_day_of_week = updates.preferredDayOfWeek;
    if (updates.quietHours !== undefined) updateData.quiet_hours = JSON.stringify(updates.quietHours);
    if (updates.destinations !== undefined) updateData.destinations = JSON.stringify(updates.destinations);
    if (updates.isActive !== undefined) updateData.is_active = updates.isActive;
    if (updates.dailyEnabled !== undefined) updateData.daily_enabled = updates.dailyEnabled;
    if (updates.weeklyEnabled !== undefined) updateData.weekly_enabled = updates.weeklyEnabled;

    const [row] = await db("report_schedules")
      .where({ id: scheduleId })
      .update(updateData)
      .returning("*");
    if (!row) throw new Error(`Schedule not found: ${scheduleId}`);
    logger.info({ scheduleId }, "Report schedule updated");
    return this.mapScheduleRow(row);
  }

  /** Retrieve a schedule */
  public async getSchedule(scheduleId: string): Promise<ReportSchedule | null> {
    const db = getDatabase();
    const row = await db("report_schedules").where({ id: scheduleId }).first();
    return row ? this.mapScheduleRow(row) : null;
  }

  /** List active schedules for a given frequency */
  public async listActiveSchedules(frequency?: ReportFrequency): Promise<ReportSchedule[]> {
    const db = getDatabase();
    let query = db("report_schedules").where({ is_active: true });
    if (frequency) query = query.andWhere({ frequency });
    const rows = await query;
    return rows.map(this.mapScheduleRow);
  }

  // ---------------------------------------------------------------------------
  // REPORT GENERATION & DELIVERY
  // ---------------------------------------------------------------------------

  /** Generate and schedule reports for all eligible schedules */
  public async generateReports(frequency: ReportFrequency): Promise<number> {
    const schedules = await this.listActiveSchedules(frequency);
    let generated = 0;
    for (const schedule of schedules) {
      try {
        // Respect quiet hours and preferred send time
        if (this.isInQuietHours(schedule) || !this.shouldSendNow(schedule)) continue;
        await this.createReportDelivery(schedule);
        generated++;
      } catch (err) {
        logger.error({ scheduleId: schedule.id, err }, "Failed to generate report");
      }
    }
    logger.info({ frequency, generated }, "Report generation completed");
    return generated;
  }

  /** Create a pending delivery record */
  private async createReportDelivery(schedule: ReportSchedule): Promise<ReportDelivery> {
    const db = getDatabase();
    const now = new Date();
    const period = this.calculatePeriod(schedule.frequency);
    const [row] = await db("report_deliveries").insert({
      id: crypto.randomUUID(),
      schedule_id: schedule.id,
      frequency: schedule.frequency,
      user_address: schedule.userAddress,
      email: schedule.email,
      period_start: period.start,
      period_end: period.end,
      status: "pending",
      attempts: 0,
      created_at: now,
      updated_at: now,
    }).returning("*");
    return this.mapDeliveryRow(row);
  }

  /** Process pending deliveries (including retries) */
  public async processPendingDeliveries(): Promise<number> {
    const db = getDatabase();
    const pending = await db("report_deliveries")
      .where({ status: "pending" })
      .orWhere(function () {
        this.where({ status: "failed" })
          .where("attempts", "<", MAX_RETRY_ATTEMPTS)
          .where("next_retry_at", "<=", new Date());
      })
      .limit(50);
    let processed = 0;
    for (const row of pending) {
      try {
        const delivery = this.mapDeliveryRow(row);
        await this.sendReport(delivery);
        processed++;
      } catch (err) {
        logger.error({ deliveryId: row.id, err }, "Failed to process report delivery");
      }
    }
    logger.info({ processed }, "Pending report deliveries processed");
    return processed;
  }

  /** Send a report via configured destinations (currently only email) */
  private async sendReport(delivery: ReportDelivery): Promise<void> {
    const db = getDatabase();
    try {
      // Generate report content – placeholder implementation
      const reportHtml = await this.generateReportHtml(delivery);

      // Email delivery if configured
      const scheduleRow = await db("report_schedules").where({ id: delivery.scheduleId }).first();
      const schedule = this.mapScheduleRow(scheduleRow);
      // Send report via email service
      if (schedule.destinations.includes("email")) {
        const recipient: EmailRecipient = { email: delivery.email, name: delivery.userAddress };
        const payload: EmailReportPayload = {
          htmlContent: reportHtml,
          periodStart: delivery.periodStart,
          periodEnd: delivery.periodEnd,
        };
        await this.emailService.sendReportEmail(recipient, payload);
      }

      // Update status to sent
      await db("report_deliveries")
        .where({ id: delivery.id })
        .update({ status: "sent", sent_at: new Date(), attempts: delivery.attempts + 1, updated_at: new Date() });
      logger.info({ deliveryId: delivery.id }, "Report sent successfully");
    } catch (err) {
      const nextRetry = new Date();
      nextRetry.setMinutes(nextRetry.getMinutes() + RETRY_DELAY_MINUTES);
      await db("report_deliveries")
        .where({ id: delivery.id })
        .update({
          status: delivery.attempts + 1 >= MAX_RETRY_ATTEMPTS ? "failed" : "pending",
          attempts: delivery.attempts + 1,
          next_retry_at: nextRetry,
          error_message: err instanceof Error ? err.message : "Unknown error",
          updated_at: new Date(),
        });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private shouldSendNow(schedule: ReportSchedule): boolean {
    const now = new Date();
    const userHour = this.getUserHour(now, schedule.timezone);
    if (schedule.frequency === "daily") {
      return schedule.dailyEnabled && userHour === schedule.preferredHour;
    }
    if (schedule.frequency === "weekly") {
      const userDay = this.getUserDayOfWeek(now, schedule.timezone);
      return (
        schedule.weeklyEnabled &&
        userDay === schedule.preferredDayOfWeek &&
        userHour === schedule.preferredHour
      );
    }
    return false;
  }

  private isInQuietHours(schedule: ReportSchedule): boolean {
    const now = new Date();
    const hour = this.getUserHour(now, schedule.timezone);
    const { start, end } = schedule.quietHours;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  private getUserHour(date: Date, tz: string): number {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
      return parseInt(fmt.format(date), 10);
    } catch {
      return date.getUTCHours();
    }
  }

  private getUserDayOfWeek(date: Date, tz: string): number {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
      const dayName = fmt.format(date);
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return days.indexOf(dayName);
    } catch {
      return date.getUTCDay();
    }
  }

  private calculatePeriod(frequency: ReportFrequency): { start: Date; end: Date } {
    const end = new Date();
    const start = new Date();
    if (frequency === "daily") start.setDate(start.getDate() - 1);
    else start.setDate(start.getDate() - 7);
    return { start, end };
  }

  private async buildProtocolStatsSection(): Promise<string> {
    try {
      const stats = await this.analyticsService.getProtocolStats();
      return `
        <section>
          <h2>Protocol Overview</h2>
          <table>
            <tr><th>Metric</th><th>Value</th></tr>
            <tr><td>Total Value Locked</td><td>${stats.totalValueLocked}</td></tr>
            <tr><td>24h Volume</td><td>${stats.totalVolume24h}</td></tr>
            <tr><td>7d Volume</td><td>${stats.totalVolume7d}</td></tr>
            <tr><td>Active Bridges</td><td>${stats.activeBridges}</td></tr>
            <tr><td>Active Assets</td><td>${stats.activeAssets}</td></tr>
            <tr><td>Avg Health Score</td><td>${(stats.averageHealthScore * 100).toFixed(1)}%</td></tr>
            <tr><td>24h Transactions</td><td>${stats.totalTransactions24h.toLocaleString()}</td></tr>
          </table>
        </section>`;
    } catch (err) {
      logger.warn({ err }, "Failed to load protocol stats for report");
      return "<section><h2>Protocol Overview</h2><p>Data unavailable.</p></section>";
    }
  }

  private async buildAssetRankingsSection(): Promise<string> {
    try {
      const rankings = await this.analyticsService.getAssetRankings();
      const rows = rankings
        .slice(0, 10)
        .map(
          (a) =>
            `<tr><td>${a.rank}</td><td>${a.symbol}</td><td>${a.tvl}</td><td>${a.volume24h}</td><td>${(a.healthScore * 100).toFixed(1)}%</td><td>${a.trend}</td></tr>`
        )
        .join("");
      return `
        <section>
          <h2>Top Assets</h2>
          <table>
            <tr><th>#</th><th>Symbol</th><th>TVL</th><th>24h Vol</th><th>Health</th><th>Trend</th></tr>
            ${rows}
          </table>
        </section>`;
    } catch (err) {
      logger.warn({ err }, "Failed to load asset rankings for report");
      return "<section><h2>Top Assets</h2><p>Data unavailable.</p></section>";
    }
  }

  private async buildAlertSummarySection(periodStart: Date, periodEnd: Date): Promise<string> {
    try {
      const alerts = await this.alertService.getRecentAlerts(50);
      const inPeriod = alerts.filter(
        (a) => a.time >= periodStart && a.time <= periodEnd
      );
      const byPriority = inPeriod.reduce<Record<string, number>>((acc, a) => {
        acc[a.priority] = (acc[a.priority] ?? 0) + 1;
        return acc;
      }, {});
      const summaryRows = Object.entries(byPriority)
        .sort(([a], [b]) => ["critical", "high", "medium", "low"].indexOf(a) - ["critical", "high", "medium", "low"].indexOf(b))
        .map(([priority, count]) => `<tr><td>${priority}</td><td>${count}</td></tr>`)
        .join("");
      return `
        <section>
          <h2>Alert Summary</h2>
          <p>Total alerts in period: <strong>${inPeriod.length}</strong></p>
          <table>
            <tr><th>Priority</th><th>Count</th></tr>
            ${summaryRows || "<tr><td colspan='2'>No alerts in this period</td></tr>"}
          </table>
        </section>`;
    } catch (err) {
      logger.warn({ err }, "Failed to load alert summary for report");
      return "<section><h2>Alert Summary</h2><p>Data unavailable.</p></section>";
    }
  }

  private async buildReconciliationSection(): Promise<string> {
    try {
      const result = await this.reconciliationService.getDriftSummaries({});
      const rows = (result as any).summaries.slice(0, 10)
        .map(
          (d) =>
            `<tr><td>${d.assetCode}</td><td>${d.bridgeName}</td><td>${d.severity}</td><td>${d.latestRun.mismatchPercentage != null ? (d.latestRun.mismatchPercentage * 100).toFixed(3) + "%" : "—"}</td></tr>`
        )
        .join("");
      return `
        <section>
          <h2>Reconciliation</h2>
          <table>
            <tr><th>Asset</th><th>Bridge</th><th>Severity</th><th>Mismatch</th></tr>
            ${rows || "<tr><td colspan='4'>No drift detected</td></tr>"}
          </table>
        </section>`;
    } catch (err) {
      logger.warn({ err }, "Failed to load reconciliation data for report");
      return "<section><h2>Reconciliation</h2><p>Data unavailable.</p></section>";
    }
  }

  /**
   * Builds a fully-rendered HTML email report by fetching live data from four services
   * in parallel: protocol stats, asset rankings, recent alerts (filtered to the delivery
   * period), and reconciliation drift summaries.  Each section falls back to a
   * "Data unavailable" placeholder if its upstream service call fails, so a single
   * degraded dependency never prevents the report from being sent.
   */
  private async generateReportHtml(delivery: ReportDelivery): Promise<string> {
    const periodLabel = `${delivery.periodStart.toISOString().slice(0, 10)} – ${delivery.periodEnd
      .toISOString()
      .slice(0, 10)}`;

    const [protocolStats, assetRankings, alertSummary, reconciliation] = await Promise.all([
      this.buildProtocolStatsSection(),
      this.buildAssetRankingsSection(),
      this.buildAlertSummarySection(delivery.periodStart, delivery.periodEnd),
      this.buildReconciliationSection(),
    ]);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Bridge-Watch Report – ${periodLabel}</title>
  <style>
    body { font-family: sans-serif; color: #222; max-width: 900px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 1.6rem; border-bottom: 2px solid #0a6; padding-bottom: 8px; }
    h2 { font-size: 1.1rem; color: #555; margin-top: 32px; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { border: 1px solid #ddd; padding: 6px 12px; text-align: left; font-size: 0.9rem; }
    th { background: #f4f4f4; }
    section { margin-bottom: 32px; }
    footer { font-size: 0.75rem; color: #aaa; margin-top: 48px; }
  </style>
</head>
<body>
  <h1>Bridge-Watch Report</h1>
  <p><strong>Period:</strong> ${periodLabel}</p>
  ${protocolStats}
  ${assetRankings}
  ${alertSummary}
  ${reconciliation}
  <footer>Generated by Bridge-Watch · ${delivery.frequency} report for ${delivery.email}</footer>
</body>
</html>`;
  }

  // ---------------------------------------------------------------------------
  // ROW MAPPERS
  // ---------------------------------------------------------------------------

  private mapScheduleRow(row: any): ReportSchedule {
    return {
      id: row.id,
      templateId: row.template_id,
      frequency: row.frequency,
      userAddress: row.user_address,
      email: row.email,
      timezone: row.timezone,
      preferredHour: row.preferred_hour,
      preferredDayOfWeek: row.preferred_day_of_week,
      quietHours: JSON.parse(row.quiet_hours),
      destinations: JSON.parse(row.destinations),
      isActive: row.is_active,
      dailyEnabled: row.daily_enabled,
      weeklyEnabled: row.weekly_enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDeliveryRow(row: any): ReportDelivery {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      frequency: row.frequency,
      userAddress: row.user_address,
      email: row.email,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      status: row.status,
      attempts: row.attempts,
      sentAt: row.sent_at,
      nextRetryAt: row.next_retry_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
