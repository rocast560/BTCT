import type { Page, GraphNode, GraphEdge } from '@/types';
import { v4 as uuidv4 } from 'uuid';

const now = Date.now();

export const fixturePages: Page[] = [
  {
    id: 'page-1',
    workspaceId: 'ws-1',
    parentId: null,
    title: 'Test Page',
    slug: 'test-page',
    icon: '📄',
    tags: ['test', 'demo'],
    content: [
      { id: uuidv4(), type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Hello World', styles: {} }], children: [] },
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'This is a test page.', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Item one', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Bold item', styles: { bold: true } }], children: [], props: {} },
    ],
    sortOrder: 0,
    isGraphPage: false,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'page-2',
    workspaceId: 'ws-1',
    parentId: null,
    title: 'Node Page',
    slug: 'node-page',
    icon: '🖥️',
    tags: [],
    content: [
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'Linked from a graph node.', styles: {} }], children: [], props: {} },
    ],
    sortOrder: 1,
    isGraphPage: true,
    createdAt: now,
    updatedAt: now,
  },
];

export const fixtureNodes: GraphNode[] = [
  {
    id: 'node-1',
    graphId: 'graph-1',
    type: 'host',
    label: 'WEB-01',
    position: { x: 100, y: 50 },
    data: { hostname: 'WEB-01', ip: '10.0.0.1', os: 'Linux', openPorts: [80, 443] },
    linkedPageId: 'page-2',
    discoveredAt: now,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'node-2',
    graphId: 'graph-1',
    type: 'credential',
    label: 'admin',
    position: { x: 300, y: 200 },
    data: { username: 'admin', secret: 'hash123', source: 'dump' },
    linkedPageId: 'page-2',
    discoveredAt: now,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'node-3',
    graphId: 'graph-1',
    type: 'finding',
    label: 'SQLi',
    position: { x: 500, y: 350 },
    data: { title: 'SQL Injection', severity: 'critical' as const, cvss: 9.1 },
    linkedPageId: 'page-2',
    discoveredAt: now,
    createdAt: now,
    updatedAt: now,
  },
];

export const fixtureEdges: GraphEdge[] = [
  {
    id: 'edge-1',
    graphId: 'graph-1',
    sourceNodeId: 'node-1',
    targetNodeId: 'node-2',
    edgeType: 'AdminTo',
    label: 'AdminTo',
    linkedPageId: null,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'edge-2',
    graphId: 'graph-1',
    sourceNodeId: 'node-2',
    targetNodeId: 'node-3',
    edgeType: 'Exploits',
    label: 'Exploits',
    linkedPageId: null,
    createdAt: now,
    updatedAt: now,
  },
];
