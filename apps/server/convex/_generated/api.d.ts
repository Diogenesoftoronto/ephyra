/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as agent_auth from "../agent_auth.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as drafts from "../drafts.js";
import type * as ledger from "../ledger.js";
import type * as lib from "../lib.js";
import type * as runs from "../runs.js";
import type * as runtime from "../runtime.js";
import type * as signals from "../signals.js";
import type * as usage from "../usage.js";
import type * as worker_owner from "../worker_owner.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  agent_auth: typeof agent_auth;
  audit: typeof audit;
  auth: typeof auth;
  drafts: typeof drafts;
  ledger: typeof ledger;
  lib: typeof lib;
  runs: typeof runs;
  runtime: typeof runtime;
  signals: typeof signals;
  usage: typeof usage;
  worker_owner: typeof worker_owner;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
