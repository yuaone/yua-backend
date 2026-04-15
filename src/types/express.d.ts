// 🔥 YUA-AI Express Request / User SSOT (HARDENED)
// - Works for:
//   - Express namespace (Express.User / Express.Request)
//   - express-serve-static-core Request
//   - express Request
//
// Put this file at: src/types/express.d.ts

import "express";
import "express-serve-static-core";
import type { PlanId } from "./plan-types";

declare global {
  namespace Express {
    interface User {
      userId: number;
      id: number; // alias (legacy)
      firebaseUid: string;
      email: string | null;
      name: string | null;
      role?: string;
      authProvider?: "google" | "email" | null;
      /** Resolved plan tier (populated by resolvePlanTier middleware). */
      planTier?: PlanId;
      /** Cached primary workspace id for the user; null if none. */
      workspaceIdCached?: number | null;
    }

    interface Request {
      traceId?: string;

      user?: User;

      workspace?: {
        id: string; // uuid
        role?: "owner" | "admin" | "member" | "viewer";
      };

      subscription?: {
        plan: PlanId;
        status: "active" | "inactive";
        expireAt?: number;
      } | null;

      apiKeyMeta?: {
        raw?: string;
        hash?: string;
        plan?: string;
        ownerId?: string;
      } | null;

      /** 내부 미들웨어 확장 필드 */
      _apiKeyAuth?: boolean;
      _apiKeyScope?: string;
      ownerLevel1?: boolean;
      ownerMode?: boolean;
      creditBalance?: number;
      _workspaceTier?: string;
      _authMeta?: Record<string, unknown>;
      instanceId?: string;
      apiKeyId?: number;

      clientVersion?: string;
      platform?: string;
      device?: string;
      requestAt?: number;
    }
  }
}

/**
 * ✅ Core request type used under the hood by express typings
 */
declare module "express-serve-static-core" {
  interface Request {
    traceId?: string;

    user?: Express.User;

    workspace?: {
      id: string;
      role?: "owner" | "admin" | "member" | "viewer";
    };

    subscription?: {
      plan: PlanId;
      status: "active" | "inactive";
      expireAt?: number;
    } | null;

    apiKeyMeta?: {
      raw?: string;
      hash?: string;
      plan?: string;
      ownerId?: string;
    } | null;

    _apiKeyAuth?: boolean;
    _apiKeyScope?: string;
    ownerLevel1?: boolean;
    ownerMode?: boolean;
    creditBalance?: number;
    _workspaceTier?: string;
    _authMeta?: Record<string, unknown>;
    instanceId?: string;
    apiKeyId?: number;

    clientVersion?: string;
    platform?: string;
    device?: string;
    requestAt?: number;
  }
}

/**
 * ✅ Some files import Request directly from "express"
 * (belt & suspenders)
 */
declare module "express" {
  interface Request {
    traceId?: string;

    user?: Express.User;

    workspace?: {
      id: string;
      role?: "owner" | "admin" | "member" | "viewer";
    };

    subscription?: {
      plan: PlanId;
      status: "active" | "inactive";
      expireAt?: number;
    } | null;

    apiKeyMeta?: {
      raw?: string;
      hash?: string;
      plan?: string;
      ownerId?: string;
    } | null;

    _apiKeyAuth?: boolean;
    _apiKeyScope?: string;
    ownerLevel1?: boolean;
    ownerMode?: boolean;
    creditBalance?: number;
    _workspaceTier?: string;
    _authMeta?: Record<string, unknown>;
    instanceId?: string;
    apiKeyId?: number;

    clientVersion?: string;
    platform?: string;
    device?: string;
    requestAt?: number;
  }
}

export {};
