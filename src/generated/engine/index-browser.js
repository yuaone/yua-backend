
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  getRuntime,
  skip
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.22.0
 * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
 */
Prisma.prismaVersion = {
  client: "5.22.0",
  engine: "605197351a3c8bdd595af2d2a9bc3025bca48ea2"
}

Prisma.PrismaClientKnownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientKnownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientUnknownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientRustPanicError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientInitializationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientValidationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`NotFoundError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`sqltag is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`empty is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`join is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`raw is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.getExtensionContext is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.defineExtension is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}



/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  ReadUncommitted: 'ReadUncommitted',
  ReadCommitted: 'ReadCommitted',
  RepeatableRead: 'RepeatableRead',
  Serializable: 'Serializable'
});

exports.Prisma.InstanceScalarFieldEnum = {
  id: 'id',
  name: 'name',
  ownerId: 'ownerId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  cpuTierId: 'cpuTierId',
  nodeTierId: 'nodeTierId',
  engineTierId: 'engineTierId',
  qpuTierId: 'qpuTierId',
  omegaTierId: 'omegaTierId',
  status: 'status',
  autoscale: 'autoscale'
};

exports.Prisma.InstanceEngineScalarFieldEnum = {
  id: 'id',
  instanceId: 'instanceId',
  engineType: 'engineType',
  enabled: 'enabled',
  defaultModel: 'defaultModel',
  allowedModels: 'allowedModels',
  createdAt: 'createdAt'
};

exports.Prisma.InstancePolicyScalarFieldEnum = {
  id: 'id',
  instanceId: 'instanceId',
  allowChat: 'allowChat',
  allowEmotion: 'allowEmotion',
  allowMemory: 'allowMemory',
  allowFinance: 'allowFinance',
  allowTerminal: 'allowTerminal',
  allowSSH: 'allowSSH',
  maxTokensPerDay: 'maxTokensPerDay',
  maxRequestsPerDay: 'maxRequestsPerDay',
  ipWhitelist: 'ipWhitelist',
  regionLock: 'regionLock',
  auditRequired: 'auditRequired',
  piiStrictMode: 'piiStrictMode',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.CpuTierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  cores: 'cores',
  price: 'price'
};

exports.Prisma.NodeTierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  nodes: 'nodes',
  price: 'price'
};

exports.Prisma.EngineTierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  profile: 'profile',
  price: 'price'
};

exports.Prisma.QpuTierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  parallel: 'parallel',
  price: 'price'
};

exports.Prisma.OmegaTierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  cognitive: 'cognitive',
  price: 'price'
};

exports.Prisma.SnapshotScalarFieldEnum = {
  id: 'id',
  instanceId: 'instanceId',
  metadata: 'metadata',
  createdAt: 'createdAt'
};

exports.Prisma.InstanceLogScalarFieldEnum = {
  id: 'id',
  instanceId: 'instanceId',
  event: 'event',
  detail: 'detail',
  createdAt: 'createdAt'
};

exports.Prisma.BillingRecordScalarFieldEnum = {
  id: 'id',
  instanceId: 'instanceId',
  amount: 'amount',
  reason: 'reason',
  createdAt: 'createdAt'
};

exports.Prisma.ExecutionGraphScalarFieldEnum = {
  id: 'id',
  instanceId: 'instanceId',
  graph: 'graph',
  createdAt: 'createdAt'
};

exports.Prisma.Snapshot_historyScalarFieldEnum = {
  id: 'id',
  snapshot_name: 'snapshot_name',
  instance_id: 'instance_id',
  created_at: 'created_at'
};

exports.Prisma.TerminalSessionScalarFieldEnum = {
  id: 'id',
  token: 'token',
  instanceId: 'instanceId',
  userId: 'userId',
  scope: 'scope',
  issuedAt: 'issuedAt',
  expiresAt: 'expiresAt',
  revokedAt: 'revokedAt',
  lastVerifiedAt: 'lastVerifiedAt'
};

exports.Prisma.BillingSubscriptionScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  workspaceId: 'workspaceId',
  provider: 'provider',
  lsSubscriptionId: 'lsSubscriptionId',
  lsCustomerId: 'lsCustomerId',
  lsVariantId: 'lsVariantId',
  lsOrderId: 'lsOrderId',
  planTier: 'planTier',
  status: 'status',
  currentPeriodStart: 'currentPeriodStart',
  currentPeriodEnd: 'currentPeriodEnd',
  cancelAtPeriodEnd: 'cancelAtPeriodEnd',
  updateUrl: 'updateUrl',
  cancelUrl: 'cancelUrl',
  trialEndsAt: 'trialEndsAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.BillingEventScalarFieldEnum = {
  id: 'id',
  lsEventId: 'lsEventId',
  eventName: 'eventName',
  userId: 'userId',
  subscriptionId: 'subscriptionId',
  payload: 'payload',
  processedAt: 'processedAt'
};

exports.Prisma.WorkspaceUsageLogScalarFieldEnum = {
  id: 'id',
  workspaceId: 'workspaceId',
  userId: 'userId',
  threadId: 'threadId',
  messageId: 'messageId',
  model: 'model',
  resolved: 'resolved',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  cachedTokens: 'cachedTokens',
  reasoningTokens: 'reasoningTokens',
  costUsd: 'costUsd',
  planTier: 'planTier',
  computeTier: 'computeTier',
  createdAt: 'createdAt'
};

exports.Prisma.UserUsageWeeklyScalarFieldEnum = {
  userId: 'userId',
  weekStartKst: 'weekStartKst',
  messages: 'messages',
  costUsd: 'costUsd',
  updatedAt: 'updatedAt'
};

exports.Prisma.UserConnectorScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  provider: 'provider',
  status: 'status',
  accessToken: 'accessToken',
  refreshToken: 'refreshToken',
  scopes: 'scopes',
  externalId: 'externalId',
  connectedAt: 'connectedAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.UserBillingCapScalarFieldEnum = {
  userId: 'userId',
  monthlyCapUsd: 'monthlyCapUsd',
  autoRefreshEnabled: 'autoRefreshEnabled',
  updatedAt: 'updatedAt'
};

exports.Prisma.UserSessionScalarFieldEnum = {
  sessionId: 'sessionId',
  userId: 'userId',
  deviceLabel: 'deviceLabel',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent',
  createdAt: 'createdAt',
  lastSeenAt: 'lastSeenAt',
  revokedAt: 'revokedAt'
};

exports.Prisma.UserConnectorInterestScalarFieldEnum = {
  userId: 'userId',
  provider: 'provider',
  createdAt: 'createdAt'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.JsonNullValueInput = {
  JsonNull: Prisma.JsonNull
};

exports.Prisma.NullableJsonNullValueInput = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull
};

exports.Prisma.QueryMode = {
  default: 'default',
  insensitive: 'insensitive'
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};

exports.Prisma.JsonNullValueFilter = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull,
  AnyNull: Prisma.AnyNull
};
exports.InstanceStatus = exports.$Enums.InstanceStatus = {
  CREATED: 'CREATED',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR'
};

exports.EngineType = exports.$Enums.EngineType = {
  chat: 'chat',
  emotion: 'emotion',
  memory: 'memory',
  finance: 'finance'
};

exports.Prisma.ModelName = {
  Instance: 'Instance',
  InstanceEngine: 'InstanceEngine',
  InstancePolicy: 'InstancePolicy',
  CpuTier: 'CpuTier',
  NodeTier: 'NodeTier',
  EngineTier: 'EngineTier',
  QpuTier: 'QpuTier',
  OmegaTier: 'OmegaTier',
  Snapshot: 'Snapshot',
  InstanceLog: 'InstanceLog',
  BillingRecord: 'BillingRecord',
  ExecutionGraph: 'ExecutionGraph',
  snapshot_history: 'snapshot_history',
  TerminalSession: 'TerminalSession',
  BillingSubscription: 'BillingSubscription',
  BillingEvent: 'BillingEvent',
  WorkspaceUsageLog: 'WorkspaceUsageLog',
  UserUsageWeekly: 'UserUsageWeekly',
  UserConnector: 'UserConnector',
  UserBillingCap: 'UserBillingCap',
  UserSession: 'UserSession',
  UserConnectorInterest: 'UserConnectorInterest'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        let message
        const runtime = getRuntime()
        if (runtime.isEdge) {
          message = `PrismaClient is not configured to run in ${runtime.prettyName}. In order to run Prisma Client on edge runtime, either:
- Use Prisma Accelerate: https://pris.ly/d/accelerate
- Use Driver Adapters: https://pris.ly/d/driver-adapters
`;
        } else {
          message = 'PrismaClient is unable to run in this browser environment, or has been bundled for the browser (running in `' + runtime.prettyName + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
