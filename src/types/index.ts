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
  content: PartialBlockContent;
  sortOrder: number;
  isGraphPage: boolean; // true = auto-created for a graph node, hidden from page tree
  createdAt: number;
  updatedAt: number;
}

// BlockNote PartialBlock[] — kept opaque for Dexie storage
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartialBlockContent = readonly Record<string, any>[];

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

export interface FindingData {
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  cvss: number;
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

// ---- UI State Types ----
export type TabKind = 'page' | 'graph' | 'nmap' | 'nmap-machine' | 'findings' | 'timeline';

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
export type ChangeAction = 'create' | 'update' | 'delete';
export type ChangeTarget = 'page' | 'graph' | 'node' | 'edge';

export interface ChangeLogEntry {
  id: ID;
  workspaceId: ID;
  action: ChangeAction;
  target: ChangeTarget;
  targetId: ID;
  summary: string;
  timestamp: number;
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
export interface AttackChain {
  id: ID;
  workspaceId: ID;
  graphId: ID;
  name: string;
  nodeIds: ID[];
  createdAt: number;
  updatedAt: number;
}

// ---- Attack Chain ----
// Ordered sequence of GraphNode IDs (all within the same Graph) that the user
// has marked as belonging to a named attack chain. When the chain is selected
// it is highlighted on the canvas using the red "chain" path style.
export interface AttackChain {
  id: ID;
  workspaceId: ID;
  graphId: ID;
  name: string;
  nodeIds: ID[];
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
  return { title: '', severity: 'info', cvss: 0 };
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
