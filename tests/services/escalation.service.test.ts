import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDb } from "../helpers/knexMock.js";
import { EscalationService } from "../../src/services/escalation.service.js";
import type { EscalationRule } from "../../src/services/escalation.service.js";

const mockDb = () =>
  createMockDb(["incidents", "escalation_rules", "escalation_history"]);

vi.mock("../../src/database/connection.js", () => ({ getDatabase: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("EscalationService", () => {
  let service: EscalationService;
  let db: any;

  beforeEach(async () => {
    const { getDatabase } = await import("../../src/database/connection.js");
    db = mockDb();
    vi.mocked(getDatabase).mockReturnValue(db);
    service = new EscalationService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── createIncident ─────────────────────────────────────────────────────────

  describe("createIncident", () => {
    it("creates a new incident with default values", async () => {
      const incident = await service.createIncident({
        title: "High severity incident",
        description: "Test incident",
        severity: "high",
        status: "open",
        assigned_to: "user123",
      });

      expect(incident).toBeDefined();
      expect(incident.id).toBeDefined();
      expect(incident.title).toBe("High severity incident");
      expect(incident.severity).toBe("high");
      expect(incident.current_escalation_level).toBe(1);
      expect(incident.acknowledged_at).toBeNull();
      expect(incident.acknowledged_by).toBeNull();
      expect(incident.resolved_at).toBeNull();
      expect(incident.resolved_by).toBeNull();
    });

    it("creates incident with critical severity", async () => {
      const incident = await service.createIncident({
        title: "Critical production issue",
        description: "Database down",
        severity: "critical",
        status: "open",
        assigned_to: null,
      });

      expect(incident.severity).toBe("critical");
      expect(incident.current_escalation_level).toBe(1);
    });

    it("handles errors during incident creation", async () => {
      db("incidents").insert.mockRejectedValueOnce(new Error("Database error"));

      await expect(
        service.createIncident({ title: "Test", description: "Test", severity: "low", status: "open", assigned_to: null })
      ).rejects.toThrow("Database error");
    });
  });

  // ── acknowledgeIncident ────────────────────────────────────────────────────

  describe("acknowledgeIncident", () => {
    it("acknowledges an incident", async () => {
      await service.acknowledgeIncident("incident-123", "user456");

      const updateCall = db("incidents").update.mock.calls[0][0];
      expect(updateCall.status).toBe("acknowledged");
      expect(updateCall.acknowledged_by).toBe("user456");
      expect(updateCall.acknowledged_at).toBeInstanceOf(Date);
    });

    it("handles errors during acknowledgement", async () => {
      db("incidents").update.mockRejectedValueOnce(new Error("Update failed"));

      await expect(service.acknowledgeIncident("id", "user")).rejects.toThrow("Update failed");
    });
  });

  // ── resolveIncident ────────────────────────────────────────────────────────

  describe("resolveIncident", () => {
    it("resolves an incident", async () => {
      await service.resolveIncident("incident-456", "user789");

      const updateCall = db("incidents").update.mock.calls[0][0];
      expect(updateCall.status).toBe("resolved");
      expect(updateCall.resolved_by).toBe("user789");
      expect(updateCall.resolved_at).toBeInstanceOf(Date);
    });

    it("handles errors during resolution", async () => {
      db("incidents").update.mockRejectedValueOnce(new Error("Resolution failed"));

      await expect(service.resolveIncident("id", "user")).rejects.toThrow("Resolution failed");
    });
  });

  // ── escalateIncident ───────────────────────────────────────────────────────

  describe("escalateIncident", () => {
    it("escalates an incident when rule exists", async () => {
      db("incidents").first.mockResolvedValueOnce({
        id: "incident-123", severity: "high", current_escalation_level: 1, status: "open",
      });
      db("escalation_rules").first.mockResolvedValueOnce({
        id: "rule-1", to_level: 2,
        notification_channels: JSON.stringify(["email", "slack"]),
        route_to: JSON.stringify(["team-lead"]),
      });

      await service.escalateIncident("incident-123", "Timeout exceeded");

      expect(db("incidents").update).toHaveBeenCalled();
      expect(db("escalation_history").insert).toHaveBeenCalled();
    });

    it("throws error when incident not found", async () => {
      db("incidents").first.mockResolvedValueOnce(null);

      await expect(service.escalateIncident("nonexistent", "reason")).rejects.toThrow("Incident not found");
    });

    it("handles missing escalation rule gracefully", async () => {
      db("incidents").first.mockResolvedValueOnce({
        id: "incident-123", severity: "low", current_escalation_level: 5,
      });
      db("escalation_rules").first.mockResolvedValueOnce(null);

      await service.escalateIncident("incident-123", "reason");

      expect(db("incidents").update).not.toHaveBeenCalled();
    });

    it("escalates with manual escalation type", async () => {
      db("incidents").first.mockResolvedValueOnce({
        id: "incident-123", severity: "critical", current_escalation_level: 1,
      });
      db("escalation_rules").first.mockResolvedValueOnce({
        id: "rule-1", to_level: 2,
        notification_channels: JSON.stringify(["email"]),
        route_to: JSON.stringify(["on-call"]),
      });

      await service.escalateIncident("incident-123", "Manual escalation", "manual");

      const historyInsert = db("escalation_history").insert.mock.calls[0][0];
      expect(historyInsert.escalated_by).toBe("manual");
      expect(historyInsert.reason).toBe("Manual escalation");
    });
  });

  // ── createEscalationRule ───────────────────────────────────────────────────

  describe("createEscalationRule", () => {
    it("creates a new escalation rule", async () => {
      const rule = await service.createEscalationRule({
        name: "Critical escalation",
        severity: "critical",
        from_level: 1,
        to_level: 2,
        timeout_minutes: 15,
        require_acknowledgement: true,
        notification_channels: ["email", "sms"],
        route_to: ["on-call-team"],
        is_active: true,
      });

      expect(rule).toBeDefined();
      expect(rule.id).toBeDefined();
      expect(rule.name).toBe("Critical escalation");
      expect(rule.severity).toBe("critical");
      expect(rule.from_level).toBe(1);
      expect(rule.to_level).toBe(2);
      expect(rule.timeout_minutes).toBe(15);
    });

    it("handles errors during rule creation", async () => {
      db("escalation_rules").insert.mockRejectedValueOnce(new Error("Constraint violation"));

      await expect(
        service.createEscalationRule({
          name: "Test", severity: "high", from_level: 1, to_level: 2,
          timeout_minutes: 30, require_acknowledgement: false,
          notification_channels: [], route_to: [], is_active: true,
        })
      ).rejects.toThrow("Constraint violation");
    });
  });

  // ── getIncident ────────────────────────────────────────────────────────────

  describe("getIncident", () => {
    it("retrieves an incident by id", async () => {
      const mockIncident = { id: "incident-123", title: "Test incident", severity: "high" };
      db("incidents").first.mockResolvedValueOnce(mockIncident);

      const incident = await service.getIncident("incident-123");

      expect(incident).toEqual(mockIncident);
      expect(db("incidents").where).toHaveBeenCalledWith({ id: "incident-123" });
    });

    it("returns null when incident not found", async () => {
      db("incidents").first.mockResolvedValueOnce(null);
      expect(await service.getIncident("nonexistent")).toBeNull();
    });

    it("handles database errors gracefully", async () => {
      db("incidents").first.mockRejectedValueOnce(new Error("Database error"));
      expect(await service.getIncident("incident-123")).toBeNull();
    });
  });

  // ── getEscalationHistory ───────────────────────────────────────────────────

  describe("getEscalationHistory", () => {
    it("retrieves escalation history for an incident", async () => {
      const mockHistory = [
        { id: "h1", incident_id: "incident-123", from_level: 1, to_level: 2, reason: "Timeout",    escalated_by: "system", escalated_at: new Date(), notified_users: JSON.stringify(["user1", "user2"]) },
        { id: "h2", incident_id: "incident-123", from_level: 2, to_level: 3, reason: "Unresolved", escalated_by: "manual", escalated_at: new Date(), notified_users: JSON.stringify(["manager"]) },
      ];
      db("escalation_history").orderBy.mockResolvedValueOnce(mockHistory);

      const history = await service.getEscalationHistory("incident-123");

      expect(history).toHaveLength(2);
      expect(history[0].notified_users).toEqual(["user1", "user2"]);
      expect(history[1].notified_users).toEqual(["manager"]);
    });

    it("returns empty array when no history exists", async () => {
      db("escalation_history").orderBy.mockResolvedValueOnce([]);
      expect(await service.getEscalationHistory("incident-123")).toEqual([]);
    });

    it("handles database errors gracefully", async () => {
      db("escalation_history").orderBy.mockRejectedValueOnce(new Error("Query failed"));
      expect(await service.getEscalationHistory("incident-123")).toEqual([]);
    });
  });

  // ── getAllRules ────────────────────────────────────────────────────────────

  describe("getAllRules", () => {
    it("retrieves all active escalation rules", async () => {
      const mockRules = [
        { id: "rule-1", severity: "critical", from_level: 1, is_active: true, notification_channels: JSON.stringify(["email"]),  route_to: JSON.stringify(["team1"]) },
        { id: "rule-2", severity: "high",     from_level: 1, is_active: true, notification_channels: JSON.stringify(["slack"]),  route_to: JSON.stringify(["team2"]) },
      ];

      db.__store.escalation_rules.push(...mockRules);

      const rules = await service.getAllRules();

      expect(rules).toHaveLength(2);
      expect(rules[0].notification_channels).toEqual(["email"]);
      expect(rules[0].route_to).toEqual(["team1"]);
      expect(rules[1].notification_channels).toEqual(["slack"]);
    });

    it("returns empty array when no rules exist", async () => {
      db("escalation_rules").orderBy.mockResolvedValueOnce([]);
      expect(await service.getAllRules()).toEqual([]);
    });

    it("handles database errors gracefully", async () => {
      db("escalation_rules").orderBy.mockRejectedValueOnce(new Error("Query failed"));
      expect(await service.getAllRules()).toEqual([]);
    });
  });

  // ── engine lifecycle ───────────────────────────────────────────────────────

  describe("startEngine and stopEngine", () => {
    it("starts the escalation engine", () => {
      service.startEngine();
      expect(service["isRunning"]).toBe(true);
    });

    it("does not start engine twice", () => {
      service.startEngine();
      service.startEngine();
      expect(service["isRunning"]).toBe(true);
    });

    it("stops the escalation engine", () => {
      service.startEngine();
      service.stopEngine();
      expect(service["isRunning"]).toBe(false);
    });

    it("handles stopping when not running", () => {
      service.stopEngine();
      expect(service["isRunning"]).toBe(false);
    });
  });

  // ── escalation thresholds ──────────────────────────────────────────────────

  describe("escalation thresholds", () => {
    it("escalates when timeout threshold is exceeded", async () => {
      const pastTime = new Date(Date.now() - 60 * 60 * 1000);
      const incident = { id: "incident-123", severity: "high", current_escalation_level: 1, status: "open", updated_at: pastTime, acknowledged_at: null };
      const rule = { id: "rule-1", timeout_minutes: 30, require_acknowledgement: false, to_level: 2, notification_channels: JSON.stringify([]), route_to: JSON.stringify([]) };

      db("incidents").first.mockResolvedValue(incident);
      db("escalation_rules").first.mockResolvedValue(rule);

      await service["monitorIncident"]("incident-123");

      expect(db("incidents").update).toHaveBeenCalled();
    });

    it("does not escalate before timeout", async () => {
      const recentTime = new Date(Date.now() - 10 * 60 * 1000);

      db("incidents").first.mockResolvedValueOnce({ id: "incident-123", severity: "low", current_escalation_level: 1, status: "open", updated_at: recentTime });
      db("escalation_rules").first.mockResolvedValueOnce({ timeout_minutes: 30, require_acknowledgement: false });

      await service["monitorIncident"]("incident-123");

      expect(db("incidents").update).not.toHaveBeenCalled();
    });

    it("escalates when acknowledgement required but not received", async () => {
      const pastTime = new Date(Date.now() - 45 * 60 * 1000);
      const incident = { id: "incident-123", severity: "critical", current_escalation_level: 1, status: "open", updated_at: pastTime, acknowledged_at: null };
      const rule = { timeout_minutes: 30, require_acknowledgement: true, to_level: 2, notification_channels: JSON.stringify([]), route_to: JSON.stringify([]) };

      const rule = {
        timeout_minutes: 30,
        require_acknowledgement: true,
        to_level: 2,
        notification_channels: JSON.stringify([]),
        route_to: JSON.stringify([]),
      };

      db("incidents").first.mockResolvedValue(incident);
      db("escalation_rules").first.mockResolvedValue(rule);

      await service["monitorIncident"]("incident-123");

      expect(db("incidents").update).toHaveBeenCalled();
    });

    it("does not escalate when acknowledged and acknowledgement required", async () => {
      const pastTime = new Date(Date.now() - 45 * 60 * 1000);

      db("incidents").first.mockResolvedValueOnce({
        id: "incident-123", severity: "high", current_escalation_level: 1,
        status: "acknowledged", updated_at: pastTime, acknowledged_at: new Date(),
      });
      db("escalation_rules").first.mockResolvedValueOnce({
        timeout_minutes: 30, require_acknowledgement: true,
      });

      await service["monitorIncident"]("incident-123");

      expect(db("incidents").update).not.toHaveBeenCalled();
    });
  });

  // ── incident status handling ───────────────────────────────────────────────

  describe("incident status handling", () => {
    it("does not monitor resolved incidents", async () => {
      db("incidents").first.mockResolvedValueOnce({ id: "incident-123", status: "resolved" });

      await service["monitorIncident"]("incident-123");

      expect(db("escalation_rules").where).not.toHaveBeenCalled();
    });

    it("does not monitor closed incidents", async () => {
      db("incidents").first.mockResolvedValueOnce({ id: "incident-123", status: "closed" });

      await service["monitorIncident"]("incident-123");

      expect(db("escalation_rules").where).not.toHaveBeenCalled();
    });
  });
});
