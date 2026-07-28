import type { FastifyDynamicSwaggerOptions } from "@fastify/swagger";
import type { FastifySchema } from "fastify";

const DEFAULT_ERROR_RESPONSE = {
  type: "object",
  properties: {
    error: { type: "string", example: "Internal Server Error" },
    message: { type: "string", example: "Unexpected error while processing request" },
  },
};

function resolveTagFromPath(url: string): string {
  if (url.startsWith("/api/v1/alerts")) return "Alerts";
  if (url.startsWith("/api/v1/assets")) return "Assets";
  if (url.startsWith("/api/v1/bridges")) return "Bridges";
  if (url.startsWith("/api/v1/analytics")) return "Analytics";
  if (url.startsWith("/api/v1/aggregation")) return "Aggregation";
  if (url.startsWith("/api/v1/metadata")) return "Metadata";
  if (url.startsWith("/api/v1/watchlists")) return "Watchlists";
  if (url.startsWith("/api/v1/preferences")) return "Preferences";
  if (url.startsWith("/api/v1/jobs")) return "Jobs";
  if (url.startsWith("/api/v1/config")) return "Config";
  if (url.startsWith("/api/v1/cache")) return "Cache";
  if (url.startsWith("/api/v1/circuit-breaker")) return "Circuit Breaker";
  if (url.startsWith("/api/v1/price-feeds")) return "Assets";
  if (url.startsWith("/api/v1/supply-chain")) return "Assets";
  if (url.startsWith("/api/v1/transactions")) return "Assets";
  if (url.startsWith("/api/v1/balances")) return "Assets";
  if (url.startsWith("/api/v1/webhooks")) return "Alerts";
  if (url.startsWith("/api/v1/admin")) return "Config";
  if (url.startsWith("/api/v1/auth")) return "Auth";
  if (url.startsWith("/api/v1/users")) return "Users";
  if (url.startsWith("/api/v1/wallets")) return "Wallets";
  if (url.startsWith("/api/v1/payments")) return "Payments";
  if (url.startsWith("/api/v1/risk")) return "Risk";
  if (url.startsWith("/api/v1/audit")) return "Audit";
  if (url.startsWith("/api/v1/health") || url.startsWith("/health")) return "Health";
  return "Config";
}

function isProtectedPath(url: string): boolean {
  return (
    url.startsWith("/api/v1/alerts") ||
    url.startsWith("/api/v1/admin") ||
    url.startsWith("/api/v1/jobs") ||
    url.startsWith("/api/v1/wallets") ||
    url.startsWith("/api/v1/payments") ||
    url.startsWith("/api/v1/transactions")
  );
}

export const swaggerOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Swipely API",
      version: "1.0.0",
      description: `
## Overview
Swipely is a payment platform API. This documentation covers all available endpoints.

## Authentication
Most endpoints require JWT authentication via Bearer token.

## Rate Limiting
API requests are rate-limited to prevent abuse.
      `,
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
      contact: {
        name: "Swipely Support",
        email: "support@swipely.com",
      },
    },
    servers: [
      {
        url: "http://localhost:3000/api/v1",
        description: "Development server",
      },
      {
        url: "https://api.swipely.com/api/v1",
        description: "Production server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter JWT token",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            status: { type: "string", example: "error" },
            message: { type: "string", example: "Something went wrong" },
            code: { type: "string", example: "INTERNAL_ERROR" },
          },
        },
        ValidationError: {
          type: "object",
          properties: {
            status: { type: "string", example: "error" },
            message: { type: "string", example: "Validation failed" },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", example: "email" },
                  message: { type: "string", example: "Email is required" },
                },
              },
            },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", example: "123e4567-e89b-12d3-a456-426614174000" },
            email: { type: "string", example: "user@example.com" },
            name: { type: "string", example: "John Doe" },
            role: { type: "string", enum: ["user", "admin"], example: "user" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Wallet: {
          type: "object",
          properties: {
            id: { type: "string", example: "123e4567-e89b-12d3-a456-426614174000" },
            userId: { type: "string", example: "123e4567-e89b-12d3-a456-426614174000" },
            publicKey: { type: "string", example: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" },
            balance: { type: "string", example: "100.50" },
            isFrozen: { type: "boolean", example: false },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Transaction: {
          type: "object",
          properties: {
            id: { type: "string", example: "123e4567-e89b-12d3-a456-426614174000" },
            txHash: { type: "string", example: "0x1234567890abcdef" },
            type: { type: "string", enum: ["send", "receive", "swap"] },
            amount: { type: "string", example: "25.50" },
            status: { type: "string", enum: ["pending", "completed", "failed"] },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
    tags: [
      { name: "Auth", description: "Authentication endpoints" },
      { name: "Users", description: "User management endpoints" },
      { name: "Wallets", description: "Wallet management endpoints" },
      { name: "Transactions", description: "Transaction endpoints" },
      { name: "Payments", description: "Payment processing endpoints" },
      { name: "Alerts", description: "Alert management endpoints" },
      { name: "Assets", description: "Asset management endpoints" },
      { name: "Bridges", description: "Bridge monitoring endpoints" },
      { name: "Analytics", description: "Analytics endpoints" },
      { name: "Risk", description: "Risk assessment endpoints" },
      { name: "Audit", description: "Audit log endpoints" },
      { name: "Health", description: "Health check endpoints" },
      { name: "Config", description: "Configuration endpoints" },
    ],
  },
};

// Helper to create common response schemas
export const commonResponses = {
  200: {
    description: "Success",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            data: { type: "object" },
          },
        },
      },
    },
  },
  400: {
    description: "Validation error",
    content: {
      "application/json": {
        schema: {
          $ref: "#/components/schemas/ValidationError",
        },
      },
    },
  },
  401: {
    description: "Unauthorized",
    content: {
      "application/json": {
        schema: {
          $ref: "#/components/schemas/ErrorResponse",
        },
      },
    },
  },
  403: {
    description: "Forbidden",
    content: {
      "application/json": {
        schema: {
          $ref: "#/components/schemas/ErrorResponse",
        },
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: {
          $ref: "#/components/schemas/ErrorResponse",
        },
      },
    },
  },
  500: {
    description: "Internal server error",
    content: {
      "application/json": {
        schema: {
          $ref: "#/components/schemas/ErrorResponse",
        },
      },
    },
  },
};

export const swaggerUiOptions = {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list" as const,
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    showExtensions: true,
  },
  staticCSP: true,
  transformStaticCSP: (header: string) => header,
};
