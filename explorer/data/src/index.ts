/**
 * @zkb/data: the data layer of the zkb.fi bridge screen. It sources what the rules of @zkb/core compute on: proofs
 * from the msgboard, requests to the proof queue, the indexer API, and RPC reads that name their block. Endpoints
 * are the caller's; `fetch` and `WebSocket` are the global ones unless the caller passes its own. See README.md.
 */

// Contract ABIs
export {
  messageBridgeAbi,
  tokenMediatorAbi,
  bridgedTokenAbi,
  tokenFactoryAbi,
  deliveryRouterAbi,
  beaconLightClientAbi,
  beaconForkGateAbi,
  forkRegistryAbi,
  multicall3Abi,
} from "./abis/index.js";

// Pairs, statuses and the decoding of bridge messages
export {
  type SideContracts,
  type PairSide,
  type Pair,
  type PairDefinition,
  PAIR_DEFINITIONS,
  DEFAULT_PAIR_NAME,
  deploymentFileSchema,
  type RegistryEnvironment,
  rpcVariableName,
  beaconVariableName,
  stateUrlsVariableName,
  headerRpcVariableName,
  parseStateUrls,
  finalityVariableName,
  type LoadPairOptions,
  loadPair,
  otherSide,
  sideOf,
  describePair,
} from "./pairs.js";
export {
  MESSAGE_STATUSES,
  type MessageStatus,
  type DeliveryOutcome,
  type StatusFacts,
  deriveStatus,
  isCovered,
  IN_FLIGHT_STATUSES,
  isInFlight,
  SECONDS_PER_SLOT,
  secondsPerSlot,
  defaultFinalitySeconds,
} from "./status.js";
export {
  DATA_TYPE_PASS,
  DATA_TYPE_CONFIRM,
  MESSAGE_PACKING_VERSION,
  type AmbHeader,
  type AmbMessage,
  chainIdLength,
  encodeAmbMessage,
  decodeAmbMessage,
  messageIdPrefix,
  buildMessageId,
  messageNonce,
  hasValidVersion,
} from "./amb.js";
export {
  type MediatorMessage,
  decodeMediatorMessage,
} from "./mediator-message.js";
export {
  type DecodedSend,
  decodeSend,
} from "./send-decoding.js";
export {
  type MessageRow,
  type MergeMessageInput,
  statusOfRow,
  mergeMessage,
  type TransferPatch,
  type MergeTransferInput,
  mergeTransfer,
} from "./message-merge.js";
export {
  bridgedTokenTransferAbi,
} from "./events.js";
export {
  MULTICALL3_ADDRESS,
  type BatchedCall,
  type BatchedCallResult,
  encodeAggregate3,
  decodeAggregate3,
} from "./multicall3.js";

// Feed and history queries
export {
  type FeedFilters,
  type FeedCursor,
  type FeedQueryResult,
  MAX_FEED_LIMIT,
  DEFAULT_FEED_LIMIT,
  encodeCursor,
  parseCursor,
  parseDirection,
  parseFeedQuery,
} from "./feed-query.js";
export {
  HISTORY_EVENT_KINDS,
  type HistoryEventKind,
  type HistoryEvent,
  type HistoryCursor,
  type HistoryFilters,
  type HistoryQueryResult,
  type HistoryPage,
  messageOnlyFilterNames,
  picksMessagesOnly,
  historyEventKey,
  encodeHistoryCursor,
  parseHistoryCursor,
  compareHistoryEvents,
  parseHistoryQuery,
  historyEventView,
  parseHistoryEvents,
} from "./history-query.js";

// Indexer API response views and the audit
export {
  numberOf,
  amountOf,
  type TokenRow,
  type TransferRow,
  type EscrowRow,
  type SupplyRow,
  type HeadUpdateRow,
  type LightClientHeadRow,
  type ChainTipRow,
  type GateStateRow,
  type BridgeStateRow,
  type TokenIndex,
  tokenKey,
  indexTokens,
  tokenView,
  tokenListItemView,
  feedItemView,
  escrowView,
  supplyView,
  headUpdateView,
  lastHeadUpdateView,
  type HeadViewRow,
  type HeadViewInput,
  headView,
  type GateFlags,
  type GateViewInput,
  gateView,
  type InFlightGroup,
  inFlightView,
  type VolumeGroup,
  volumeView,
  type AuditViewInput,
  auditItemView,
} from "./api-views.js";
export {
  type AuditInput,
  type AuditResult,
  auditToken,
} from "./audit.js";
export {
  DELIVERY_KINDS,
  type DeliveryKind,
  deliveryCostReportSchema,
  type DeliveryCostReport,
  type DeliveryKindReport,
  parseDeliveryCostReport,
} from "./delivery-cost-report.js";
export {
  DEFAULT_DELIVERY_GAS,
  DEFAULT_SAMPLE_LIMIT,
  type DeliveryCostSettings,
  parseDeliveryCostSettings,
} from "./delivery-cost-settings.js";
export {
  AFFIRMATION_COMPLETED_SELECTOR,
  type ReceiptLog,
  countDeliveriesInReceipt,
  isSingleDelivery,
  type DeliveryFacts,
  classifyDelivery,
  averageRoundingHalfUp,
  percentileNearestRank,
  type BaseFeeRow,
  type BuildReportInput,
  buildDeliveryCostReport,
} from "./delivery-cost.js";

// Proof messages
export {
  PROOF_MESSAGE_VERSION,
  PUBLIC_VALUES_BYTES,
  PROOF_BYTES,
  ORACLE_PROOF_MESSAGE_VERSION,
  ORACLE_PROOF_BYTES,
  PROOF_MESSAGE_BYTES,
  ORACLE_PROOF_MESSAGE_BYTES,
  type ProofMessageOptions,
  PROOF_PAIR_CODES,
  type ProofDirection,
  PROOF_DIRECTIONS,
  type ProofMessage,
  type ProofMessageFailure,
  ProofMessageError,
  type ProofMessageResult,
  type LightClientOutput,
  decodeLightClientOutput,
  encodeProofMessage,
  decodeProofMessage,
  tryDecodeProofMessage,
  proofCategoryName,
  proofCategory,
} from "./proof-message.js";

// Msgboard: reading proofs from the board and posting to it
export {
  type GrindInput,
  type GrindResult,
  type GrindFunction,
} from "./msgboard/grind-types.js";
export {
  type BoardMessage,
  type BoardSubscription,
  type BoardPublisher,
  type BoardFeed,
  MessageTooLargeError,
  type BoardPublisherInput,
  toWebSocketUrl,
  toHttpUrl,
  createBoardPublisher,
  type BoardSocket,
  type BoardFeedInput,
  createBoardFeed,
} from "./msgboard/board.js";
export {
  type JsonRequestInit,
  type BoardJsonFetcher,
  postJsonResponse,
  BoardReadError,
  readBoardMessages,
} from "./msgboard/board-http.js";
export {
  type LogSink,
} from "./log-sink.js";

// Proof queue (backend) client and the evidence package
export {
  type JsonPoster,
  BackendClientError,
  jobViewSchema,
  type JobView,
  latestProofSchema,
  type LatestProof,
  type BackendHealth,
  type ProofRequestInput,
  type ProofRequestAnswer,
  createBackendClient,
  type BackendClient,
} from "./backend-client.js";
export {
  PIPELINE_STAGES,
  type PipelineStage,
  WAITING_SERVICES,
  type WaitingService,
  WAITING_SERVICE_TEXT,
  transferProgressSchema,
  type TransferProgress,
  directionPipelineSchema,
  type DirectionPipeline,
  BENCHMARK_STEPS,
  type BenchmarkStep,
  benchmarksSchema,
  type Benchmarks,
} from "./pipeline-views.js";
export {
  proofPackageSchema,
  type ProofPackage,
  prerequisiteSchema,
  evidencePackageSchema,
  type EvidencePackage,
  type Prerequisite,
  verifyResultSchema,
} from "./prover/packages.js";

// RPC reads: the chain reader, scans, and reads that name their block
export {
  type ChainLog,
  type ChainBlock,
  type ChainReceipt,
  type BlockSelector,
  type LogRequest,
  type ViewCall,
  type ChainReader,
  type ViemClientLike,
  createViemChainReader,
  type HttpChainReaderInput,
  createHttpChainReader,
} from "./rpc/chain-reader.js";
export {
  type AtBlock,
  pinReader,
  readAt,
} from "./rpc/at-block.js";
export {
  mapWithLimit,
  createSerialQueue,
} from "./rpc/concurrency.js";
export {
  type LogSource,
  type ChainScanInput,
  type ChainScan,
  createChainScan,
} from "./rpc/chain-scan.js";
export {
  BRIDGE_EVENTS,
  MEDIATOR_EVENTS,
  GATE_EVENTS,
  logSourcesOf,
} from "./rpc/events.js";
export {
  type StoredHead,
  readStoredHead,
  readExecutionBlockNumber,
  readFinalizedSlot,
  type FinalizedSlotReading,
  readFinalizedSlotAt,
  type GateReading,
  readGate,
  type MediatorReading,
  readMediatorBalances,
  type CopyReading,
  readBridgedCopy,
  readStoredHeadAt,
  readGateAt,
  readMediatorBalancesAt,
  readBridgedCopyAt,
} from "./rpc/live-reads.js";
export {
  type TokenReading,
  type CurrentHead,
  type AssembleInput,
  type Assembled,
  type Needs,
  collectNeeds,
  assemble,
} from "./rpc/assemble.js";
export {
  ConnectionNotSetError,
  type RpcExplorerOptions,
  type Snapshot,
  type RpcExplorer,
  createRpcExplorer,
} from "./rpc/explorer-state.js";
export {
  RPC_PARTIAL_FIGURES,
  type PartialFigure,
  type RpcCoverage,
  type ApiAnswer,
  RpcUnsupportedError,
  type RpcExplorerApiOptions,
  type RpcExplorerApi,
  createRpcExplorerApi,
} from "./rpc/explorer-api.js";
export {
  type HistoryScanInput,
  DEFAULT_MAXIMUM_BLOCKS,
  type ChainCoverage,
  type HistoryScan,
  scanHistory,
} from "./rpc/history-scan.js";
export {
  type ContractReader,
  type TokenMetadata,
  type TokenHints,
  readTokenMetadata,
  nativeTokenBehind,
  type BuildTokenRowInput,
  buildTokenRow,
} from "./token-facts.js";
export {
  type LightClientHead,
  type LightClientReader,
  createLightClientReader,
} from "./prover/light-client.js";
export {
  type PoolReader,
  plsUsd,
  tokenUsd,
  priceNumber,
  resolvePricingAddress,
  usdText,
  type NativePriceSource,
  nativeUsd,
  type BlockClock,
  nearestBlockAt,
  type ContractCaller,
  poolReaderOver,
  MINIMUM_DEPTH_USD,
  OMNIBRIDGE_PULSECHAIN,
  PULSECHAIN_COPY_OF,
  PULSEX_FACTORIES,
  STABLES,
  TESTNETS,
  WETH_ETHEREUM,
  WPLS,
  pricingAddress,
  weightedMedian,
  type PriceQuote,
  type Reserves,
} from "./pulsex-oracle.js";

// Endpoint settings, redaction, tests of an endpoint, fallback and the connection
export {
  REDACTED,
  maskSecret,
  MINIMUM_CREDENTIAL_LENGTH,
  isRegistrableSecret,
  redactSecrets,
  redactError,
} from "./redaction.js";
export {
  type ConnectionSettings,
  ENDPOINT_KEYS,
  type EndpointKey,
  DEFAULT_INDEXER_URL,
  EMPTY_CONNECTION_SETTINGS,
  type SettingSource,
  SETTING_SOURCES,
  type ResolvedSetting,
  type ConnectionLayer,
  type ResolvedConnection,
  type ResolveConnectionInput,
  resolveConnection,
  boardUrlOf,
  migrateBoardUrls,
  describeSource,
  type ParsedUrl,
  type UrlPurpose,
  parseConnectionUrl,
  urlSecrets,
  redactConnectionText,
  maskUrl,
  type NormalizedEndpoint,
  normalizeEndpoint,
} from "./connection-settings.js";
export {
  type HttpRequest,
  type HttpResponse,
  type HttpClient,
  type TestOutcome,
  fetchClientWithin,
  fetchClient,
  passOutcome,
  failOutcome,
  describeStatus,
  testRpcChainId,
  testBeaconGenesis,
  testIndexerUrl,
  testHealthUrl,
  testJsonRpcUrl,
} from "./connection-test.js";
export {
  type FallbackReasonCode,
  type FallbackReason,
  type SourceStatus,
  type ProbeResult,
  type FallbackOptions,
  type FallbackController,
  describeFailure,
  createFallbackController,
  type FreshnessInput,
  judgeIndexerFreshness,
} from "./fallback.js";
export {
  type JsonResponse,
  type JsonFetcher,
  fetchJsonResponse,
  ConnectionAnswerError,
  type ExplorerConnectionInput,
  type ExplorerConnection,
  createExplorerConnection,
} from "./connection.js";

// The fork evidence of the deposit gate: the confirmation that a send needs first on a chain whose gate enforces
export {
  type GateEvidenceErrorCode,
  GateEvidenceError,
  type GateChainClient,
  GATE_MODES,
  type GateMode,
  type GateStatus,
  readGateStatus,
  type BeaconProofSource,
  createBeaconProofSource,
  SHAPE_REQUEST_ORDER,
  type ReadyGateEvidence,
  type WaitForGateHeader,
  buildGateEvidence,
  describeRevert,
  type GateConfirmation,
  ensureGateConfirmed,
} from "./gate-evidence.js";
