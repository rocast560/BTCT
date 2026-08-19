export type ID = string;

// ---- Workspace ----
export interface Workspace {
  id: ID;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

// ---- Page ----
export interface Page {
  id: ID;
  workspaceId: ID;
  parentId: ID | null;
  title: string;
  slug: string;
  icon: string;
  tags: string[];
  /** Markdown source for the page body. Legacy BlockNote JSON arrays are
   *  accepted and auto-converted to markdown at load time (see
   *  normalizePageContent). At runtime, reads from pageRepo always return a
   *  string; the array shape exists only for legacy seed/fixture compatibility. */
  content: PartialBlockContent;
  sortOrder: number;
  isGraphPage: boolean; // true = auto-created for a graph node, hidden from page tree
  createdAt: number;
  updatedAt: number;
}

// Legacy alias — any code path still passing BlockNote arrays is accepted
// by pageRepo.create/update and converted to markdown before persistence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartialBlockContent = string | readonly Record<string, any>[];

// ---- Graph ----
export interface Graph {
  id: ID;
  workspaceId: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// ---- Graph Node Types ----
export const NODE_TYPES = ['host', 'credential', 'service', 'finding', 'pivot'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface HostData {
  hostname: string;
  ip: string;
  os: string;
  openPorts: number[];
}

export interface CredentialData {
  username: string;
  secret: string;
  source: string;
}

export interface ServiceData {
  name: string;
  version: string;
  port: number;
  cves: string[];
}

export type Likelihood = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Impact = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface FindingData {
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  cvss: number;
  cvssVector: string;
  likelihood: Likelihood;
  impact: Impact;
  description: string;
  businessImpact: string;
  exploitSteps: string;
  mitreAttack: string;
  mitreMitigation: string;
  remediation: string;
  hosts: string[];
  service: string;
  references: string[];
}

export interface PivotData {
  description: string;
}

export type NodeDataMap = {
  host: HostData;
  credential: CredentialData;
  service: ServiceData;
  finding: FindingData;
  pivot: PivotData;
};

export type AnyNodeData = HostData | CredentialData | ServiceData | FindingData | PivotData;

export interface GraphNode {
  id: ID;
  graphId: ID;
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  data: AnyNodeData;
  linkedPageId: ID;
  discoveredAt: number;
  createdAt: number;
  updatedAt: number;
}

// ---- Graph Edge Types ----
export const EDGE_TYPES = ['AdminTo', 'HasSession', 'MemberOf', 'Exploits', 'PivotsTo', 'Custom'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface GraphEdge {
  id: ID;
  graphId: ID;
  sourceNodeId: ID;
  targetNodeId: ID;
  edgeType: EdgeType;
  label: string;
  linkedPageId: ID | null;
  createdAt: number;
  updatedAt: number;
}

// ---- Typst assets (report screenshots + custom fonts) ----

export type TypstAssetKind = 'image' | 'font';

/**
 * A crop rectangle in *normalized* coordinates (0..1, relative to the
 * original image). Normalized rather than pixels so the rect stays correct
 * if the same record is ever reused at a different resolution, and so the
 * cropper UI can work in whatever display size it happens to be laid out at.
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a blur region hides its pixels. */
export type BlurStyle = 'gaussian' | 'pixelate';

/**
 * One blurred (redacted) rectangle, in normalized coordinates relative to
 * the *original* image — the same space as `CropRect`, but always inside the
 * unit square: blurring pixels that don't exist is meaningless. Regions are
 * anchored to the upload rather than the crop so re-framing a figure never
 * moves a redaction off its secret.
 *
 * `style` and `strength` are optional so records written before they existed
 * stay valid: absent means gaussian at strength 1 (the original behavior).
 * Strength is a multiplier clamped to `MIN_STRENGTH`..`MAX_STRENGTH` in
 * `lib/blur-math.ts`.
 */
export interface BlurRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  style?: BlurStyle;
  strength?: number;
}

/**
 * Metadata for one uploaded asset. The bytes live on the server (see
 * server/assets.mjs); this record is what syncs through the shared Yjs doc.
 *
 * `filename` doubles as the path inside the Typst virtual filesystem — an
 * image called `login-bypass.png` is referenced as
 * `#image("/assets/login-bypass.png")`.
 *
 * `crop` is applied at render time by re-encoding the image through a canvas
 * before it's handed to the compiler. The upload is never modified, so a
 * crop is always undoable and can be widened again later.
 */
export interface TypstAsset {
  id: ID;
  workspaceId: ID;
  kind: TypstAssetKind;
  filename: string;
  mime: string;
  size: number;
  /** Natural pixel dimensions. Images only; absent until first decode. */
  width?: number | null;
  height?: number | null;
  /** Normalized crop rect, or null/absent for "use the whole image". */
  crop?: CropRect | null;
  /**
   * Blurred (redacted) regions, or null/absent for none. Applied at render
   * time like `crop`; anchored to the original image, not the crop.
   */
  blurs?: BlurRegion[] | null;
  /** Family name parsed from the font file — what you pass to `#set text(font:)`. */
  fontFamily?: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---- UI State Types ----
export type TabKind = 'page' | 'graph' | 'nmap' | 'nmap-machine' | 'findings' | 'timeline' | 'typst' | 'ai' | 'cmdlog';

export interface TabItem {
  id: string;
  kind: TabKind;
  entityId: ID;
  title: string;
}

// ---- Split Pane Layout ----
export type SplitDirection = 'horizontal' | 'vertical';

export interface LeafPane {
  type: 'leaf';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitPane {
  type: 'split';
  id: string;
  direction: SplitDirection;
  children: [PaneNode, PaneNode];
  ratio: number;
}

export type PaneNode = LeafPane | SplitPane;

export type DropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom';

// ---- Change Log ----
export type ChangeAction = 'create' | 'update' | 'delete' | 'restore';
export type ChangeTarget = 'page' | 'graph' | 'node' | 'edge' | 'attackChain' | 'workspace';

export interface ChangeLogEntry {
  id: ID;
  workspaceId: ID;
  action: ChangeAction;
  target: ChangeTarget;
  targetId: ID;
  summary: string;
  timestamp: number;
  // Author attribution. Optional for backward-compat with logs written
  // before the history feature landed.
  userId?: number | null;
  userName?: string | null;
  userColor?: string | null;
  // Field-level delta. Set for `update` entries on a single field, OR
  // for `delete` entries where prevValue is the full entity JSON.
  // Strings are JSON.stringify-encoded so any value shape can roundtrip.
  field?: string | null;
  prevValue?: string | null;
  newValue?: string | null;
  // Reversible entries get a Restore button in the UI. true when we have
  // enough state captured (prevValue for update, full entity JSON for
  // delete) to put the entity back.
  reversible?: boolean;
}

// ---- Command Log ----
// One whitelisted pentest command captured by a btct-cmdlog agent on an
// operator's box. Written ONLY by the server ingest endpoint (never by a
// client repo) into both SQLite (durable archive) and the shared doc's
// `commandLogs` map (bounded live window). No Y.Text fields — every field is
// plain LWW JSON, so invariant #1 does not apply. Optional fields are declared
// `?: T | null` because a record may predate a field or the agent may omit it.
export interface CommandLogEntry {
  id: ID;                      // agent-generated; the idempotency key end to end
  workspaceId: ID;
  operator: string;            // self-asserted --operator name
  command: string;             // redacted unless the agent ran --no-redact
  tool: string;                // matched whitelist entry
  cwd?: string | null;
  host?: string | null;        // hostname of the operator's box
  localUser?: string | null;
  shellPid?: number | null;
  startedAt: number;           // agent clock (epoch ms)
  receivedAt: number;          // server clock (epoch ms)
  exitCode?: number | null;    // null while the command is still running
  durationMs?: number | null;
  redacted?: boolean;
}

// Page-body snapshot — Yjs encodeStateAsUpdate bytes of a per-page Y.Doc
// captured at a point in time. Stored in the shared doc so every client
// can browse + restore. Bytes are base64 to fit cleanly in JSON.
export interface PageSnapshot {
  id: ID;
  pageId: ID;
  workspaceId: ID;
  timestamp: number;
  userId?: number | null;
  userName?: string | null;
  userColor?: string | null;
  label?: string | null;       // human label when user explicitly named the version
  updateBase64: string;        // Y.encodeStateAsUpdate(pageDoc) -> base64
  byteLength: number;          // for UI display
}

// ---- Nmap Scan ----
export type MachineOS = 'windows' | 'linux' | 'attacker' | 'unknown';

export interface NmapScriptResult {
  id: string;
  output: string;
}

export interface NmapPort {
  port: number;
  protocol: string;
  state: string;
  service: string;
  version: string;
  scripts?: NmapScriptResult[];
}

export interface NmapMachine {
  id: ID;
  scanId: ID;
  ip: string;
  hostname: string;
  os: MachineOS;
  ports: NmapPort[];
  linkedNodeId?: ID;
  createdAt: number;
  updatedAt: number;
}

export interface NmapScan {
  id: ID;
  workspaceId: ID;
  name: string;
  importedAt: number;
  rawXml?: string;
}

// ---- Attack Chain ----
// Ordered sequence of GraphNode IDs (all within the same Graph) that the user
// has marked as belonging to a named attack chain. When the chain is selected
// it is highlighted on the canvas using the red "chain" path style.
// `linkedPageId` points at a hidden Page (isGraphPage: true) that holds the
// editable narrative / step-by-step writeup for the chain.
export interface AttackChain {
  id: ID;
  workspaceId: ID;
  graphId: ID;
  name: string;
  nodeIds: ID[];
  linkedPageId: ID | null;
  createdAt: number;
  updatedAt: number;
}

// ---- Default data factories ----
export function defaultHostData(): HostData {
  return { hostname: '', ip: '', os: '', openPorts: [] };
}

export function defaultCredentialData(): CredentialData {
  return { username: '', secret: '', source: '' };
}

export function defaultServiceData(): ServiceData {
  return { name: '', version: '', port: 0, cves: [] };
}

export function defaultFindingData(): FindingData {
  return {
    title: '',
    severity: 'info',
    cvss: 0,
    cvssVector: '',
    likelihood: 'info',
    impact: 'info',
    description: '',
    businessImpact: '',
    exploitSteps: '',
    mitreAttack: '',
    mitreMitigation: '',
    remediation: '',
    hosts: [],
    service: '',
    references: [],
  };
}

export function defaultPivotData(): PivotData {
  return { description: '' };
}

export function defaultNodeData(type: NodeType): AnyNodeData {
  switch (type) {
    case 'host': return defaultHostData();
    case 'credential': return defaultCredentialData();
    case 'service': return defaultServiceData();
    case 'finding': return defaultFindingData();
    case 'pivot': return defaultPivotData();
  }
}
