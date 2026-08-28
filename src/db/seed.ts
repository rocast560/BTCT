import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { Workspace, Page, Graph, GraphNode, GraphEdge, EdgeType } from '@/types';
import { defaultFindingData } from '@/types';

const DEMO_WORKSPACE_NAME = 'ACME Corp Engagement';

/**
 * Engagement week: Monday April 13 → Friday April 17, 2026.
 * `day` = 0 (Mon) … 4 (Fri). `hour`/`minute` are local (24h).
 */
function t(day: number, hour: number, minute = 0): number {
  return new Date(2026, 3, 13 + day, hour, minute, 0).getTime();
}

async function _wipeDemoWorkspace(): Promise<void> {
  const demo = await db.workspaces.where('name').equals(DEMO_WORKSPACE_NAME).first();
  if (!demo) return;
  const graphs = await db.graphs.where('workspaceId').equals(demo.id).toArray();
  const graphIds = graphs.map((g) => g.id);
  for (const gid of graphIds) {
    await db.graphNodes.where('graphId').equals(gid).delete();
    await db.graphEdges.where('graphId').equals(gid).delete();
  }
  await db.graphs.where('workspaceId').equals(demo.id).delete();
  await db.pages.where('workspaceId').equals(demo.id).delete();
  await db.changeLogs.where('workspaceId').equals(demo.id).delete();
  const scans = await db.nmapScans.where('workspaceId').equals(demo.id).toArray();
  for (const s of scans) {
    await db.nmapMachines.where('scanId').equals(s.id).delete();
  }
  await db.nmapScans.where('workspaceId').equals(demo.id).delete();
  await db.workspaces.delete(demo.id);
}
// Suppress unused-function warning while keeping the wipe routine available
// for future "Reset demo data" actions if the team wants to bring it back.
void _wipeDemoWorkspace;

/**
 * Seeds a realistic 5-day pentest engagement with two attack narratives and 20 findings.
 *
 * In multi-user mode the shared doc is the source of truth: only seed when
 * it is completely empty. Otherwise we'd overwrite real engagement data
 * the moment a fresh client connects. The old per-browser version-bump
 * re-seed is intentionally disabled here: it'd be destructive when other
 * users are already collaborating.
 */
export async function seedDemoWorkspace(): Promise<void> {
  const existing = await db.workspaces.count();
  if (existing > 0) return;

  const now = t(4, 17, 0); // Friday end-of-day: treated as "now" for the demo
  const createdAt = now;

  // ── Workspace ──────────────────────────────────────────────
  const workspace: Workspace = {
    id: uuidv4(),
    name: DEMO_WORKSPACE_NAME,
    description: 'Internal and external penetration test – ACME Corporation (Apr 13–17, 2026)',
    createdAt,
    updatedAt: createdAt,
  };

  // ── Static Pages ───────────────────────────────────────────
  const engagementPage: Page = {
    id: uuidv4(), workspaceId: workspace.id, parentId: null,
    title: 'Engagement Notes', slug: 'engagement-notes', icon: '',
    tags: ['engagement', 'overview'],
    content: [
      { id: uuidv4(), type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'ACME Corp – Internal Penetration Test', styles: {} }], children: [] },
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'Five-day assumed-breach internal penetration test of ACME Corporation (Apr 13–17, 2026). Scope: 10.10.10.0/24 internal corporate subnet, 10.0.0.0/24 DMZ. Domain: ACME.CORP. Starting position: non-domain-joined attacker laptop on the corporate LAN (simulating rogue device / compromised contractor).', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Rules of Engagement', styles: {} }], children: [] },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Testing window: Monday–Friday 0800-1800 EST', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Emergency contact: SOC at +1-555-0100', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'No destructive attacks or denial-of-service testing', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Domain Admin account may be obtained but must not be used to alter production data', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Timeline Summary', styles: {} }], children: [] },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Day 1 (Mon): Reconnaissance, Responder/LLMNR hash capture, offline cracking', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Day 2 (Tue): Valid domain user foothold, BloodHound enumeration, Kerberoasting', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Day 3 (Wed): GPP cpassword, lateral movement to FILE-01 and DB-01, LSASS dump', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Day 4 (Thu): DCSync via svc_backup → Domain Admin, full domain compromise', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'bulletListItem', content: [{ type: 'text', text: 'Day 5 (Fri): Post-exploitation validation, finding documentation, cleanup', styles: {} }], children: [], props: {} },
    ],
    sortOrder: 0, isGraphPage: false, createdAt, updatedAt: createdAt,
  };

  const reconPage: Page = {
    id: uuidv4(), workspaceId: workspace.id, parentId: engagementPage.id,
    title: 'Reconnaissance', slug: 'recon', icon: '',
    tags: ['recon', 'enumeration'],
    content: [
      { id: uuidv4(), type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Network Reconnaissance', styles: {} }], children: [] },
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'Monday AM: nmap -sS -sV -p- 10.10.10.0/24 identified 9 live hosts. Key services: Active Directory (DC-01, DC-02), internal web apps (WEB-01, WEB-02), SQL Server (DB-01), file share (FILE-01), mail server (MAIL-01), jump box (JUMP-01), application server (APP-01).', styles: {} }], children: [], props: {} },
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'Responder run on the corporate subnet captured NTLMv2 hashes within 90 minutes via LLMNR poisoning. Hash for ACME\\j.smith cracked offline using hashcat mode 5600 with rockyou.txt + common rules.', styles: {} }], children: [], props: {} },
    ],
    sortOrder: 0, isGraphPage: false, createdAt, updatedAt: createdAt,
  };

  const methodologyPage: Page = {
    id: uuidv4(), workspaceId: workspace.id, parentId: engagementPage.id,
    title: 'Methodology', slug: 'methodology', icon: '',
    tags: ['methodology'],
    content: [
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'OWASP Testing Guide v4, PTES, and OSSTMM methodologies applied. AD attack path analysis via BloodHound (SharpHound ingestor) enumeration. Full domain compromise achieved on Day 4 (Thursday) approximately 27 working hours after first NTLMv2 capture on Day 1.', styles: {} }], children: [], props: {} },
    ],
    sortOrder: 1, isGraphPage: false, createdAt, updatedAt: createdAt,
  };

  const findingsPage: Page = {
    id: uuidv4(), workspaceId: workspace.id, parentId: null,
    title: 'Findings Summary', slug: 'findings-summary', icon: '',
    tags: ['findings'],
    content: [
      { id: uuidv4(), type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Executive Summary', styles: {} }], children: [] },
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: '20 findings identified across internal and external assessments: 4 Critical, 5 High, 5 Medium, 4 Low, 2 Informational. Full domain compromise achieved on Day 4 through an LLMNR → Kerberoasting → GPP cpassword → DCSync attack chain.', styles: {} }], children: [], props: {} },
    ],
    sortOrder: 1, isGraphPage: false, createdAt, updatedAt: createdAt,
  };

  const remediationPage: Page = {
    id: uuidv4(), workspaceId: workspace.id, parentId: null,
    title: 'Remediation Plan', slug: 'remediation', icon: '',
    tags: ['remediation'],
    content: [
      { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: 'Priority remediation items grouped by severity. Critical findings should be addressed within 7 days, High within 30 days, Medium within 90 days.', styles: {} }], children: [], props: {} },
    ],
    sortOrder: 2, isGraphPage: false, createdAt, updatedAt: createdAt,
  };

  // ── Graphs ─────────────────────────────────────────────────
  const internalGraph: Graph = {
    id: uuidv4(), workspaceId: workspace.id,
    name: 'Internal Network – Attack Path',
    createdAt, updatedAt: createdAt,
  };

  const externalGraph: Graph = {
    id: uuidv4(), workspaceId: workspace.id,
    name: 'External Perimeter Assessment',
    createdAt, updatedAt: createdAt,
  };

  // ── Node-page helper ───────────────────────────────────────
  const nodePages: Page[] = [];
  const makeNodePage = (title: string, icon: string): Page => {
    const page: Page = {
      id: uuidv4(), workspaceId: workspace.id, parentId: null,
      title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      icon, tags: [],
      content: [
        { id: uuidv4(), type: 'paragraph', content: [{ type: 'text', text: `Details and notes for: ${title}`, styles: {} }], children: [], props: {} },
      ],
      sortOrder: 0, isGraphPage: true, createdAt, updatedAt: createdAt,
    };
    nodePages.push(page);
    return page;
  };

  // ════════════════════════════════════════════════════════════
  //  INTERNAL NETWORK GRAPH – Nodes
  // ════════════════════════════════════════════════════════════

  // ── Hosts (9) ──────────────────────────────────────────────
  const p_web01 = makeNodePage('WEB-01', '');
  const web01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'WEB-01 (10.10.10.10)', position: { x: 200, y: 0 },
    data: { hostname: 'WEB-01', ip: '10.10.10.10', os: 'Windows Server 2019', openPorts: [80, 443, 445, 3389] },
    linkedPageId: p_web01.id, discoveredAt: t(0, 8, 30), createdAt, updatedAt: createdAt,
  };

  const p_web02 = makeNodePage('WEB-02', '');
  const web02: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'WEB-02 (10.10.10.11)', position: { x: 700, y: 0 },
    data: { hostname: 'WEB-02', ip: '10.10.10.11', os: 'Ubuntu 22.04 LTS', openPorts: [22, 8080, 8443] },
    linkedPageId: p_web02.id, discoveredAt: t(0, 8, 32), createdAt, updatedAt: createdAt,
  };

  const p_db01 = makeNodePage('DB-01', '');
  const db01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'DB-01 (10.10.10.20)', position: { x: 500, y: 350 },
    data: { hostname: 'DB-01', ip: '10.10.10.20', os: 'Windows Server 2019', openPorts: [1433, 3389, 445] },
    linkedPageId: p_db01.id, discoveredAt: t(0, 8, 34), createdAt, updatedAt: createdAt,
  };

  const p_file01 = makeNodePage('FILE-01', '');
  const file01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'FILE-01 (10.10.10.30)', position: { x: 50, y: 350 },
    data: { hostname: 'FILE-01', ip: '10.10.10.30', os: 'Windows Server 2016', openPorts: [445, 139, 3389, 161] },
    linkedPageId: p_file01.id, discoveredAt: t(0, 8, 36), createdAt, updatedAt: createdAt,
  };

  const p_mail01 = makeNodePage('MAIL-01', '');
  const mail01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'MAIL-01 (10.10.10.40)', position: { x: 1000, y: 250 },
    data: { hostname: 'MAIL-01', ip: '10.10.10.40', os: 'Windows Server 2019', openPorts: [25, 443, 587, 993] },
    linkedPageId: p_mail01.id, discoveredAt: t(0, 8, 38), createdAt, updatedAt: createdAt,
  };

  const p_app01 = makeNodePage('APP-01', '');
  const app01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'APP-01 (10.10.10.50)', position: { x: 700, y: 550 },
    data: { hostname: 'APP-01', ip: '10.10.10.50', os: 'Windows Server 2019', openPorts: [80, 443, 5985] },
    linkedPageId: p_app01.id, discoveredAt: t(0, 8, 40), createdAt, updatedAt: createdAt,
  };

  const p_dc01 = makeNodePage('DC-01', '');
  const dc01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'DC-01 (10.10.10.1)', position: { x: 300, y: 950 },
    data: { hostname: 'DC-01', ip: '10.10.10.1', os: 'Windows Server 2022', openPorts: [53, 88, 135, 389, 445, 636, 3268] },
    linkedPageId: p_dc01.id, discoveredAt: t(0, 8, 42), createdAt, updatedAt: createdAt,
  };

  const p_dc02 = makeNodePage('DC-02', '');
  const dc02: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'DC-02 (10.10.10.2)', position: { x: 650, y: 950 },
    data: { hostname: 'DC-02', ip: '10.10.10.2', os: 'Windows Server 2022', openPorts: [53, 88, 135, 389, 445, 636] },
    linkedPageId: p_dc02.id, discoveredAt: t(0, 8, 44), createdAt, updatedAt: createdAt,
  };

  const p_jump01 = makeNodePage('JUMP-01', '');
  const jump01: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'host',
    label: 'JUMP-01 (10.10.10.100)', position: { x: 900, y: 850 },
    data: { hostname: 'JUMP-01', ip: '10.10.10.100', os: 'Windows 11 Pro', openPorts: [3389, 5985] },
    linkedPageId: p_jump01.id, discoveredAt: t(0, 8, 46), createdAt, updatedAt: createdAt,
  };

  // ── Services (4) ───────────────────────────────────────────
  const p_iis = makeNodePage('IIS on WEB-01', '');
  const iis: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'service',
    label: 'IIS 10.0 (443)', position: { x: 50, y: 150 },
    data: { name: 'IIS', version: '10.0', port: 443, cves: [] },
    linkedPageId: p_iis.id, discoveredAt: t(0, 9, 15), createdAt, updatedAt: createdAt,
  };

  const p_tomcat = makeNodePage('Tomcat on WEB-02', '');
  const tomcat: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'service',
    label: 'Tomcat 9.0.45 (8080)', position: { x: 900, y: 150 },
    data: { name: 'Apache Tomcat', version: '9.0.45', port: 8080, cves: ['CVE-2021-25329'] },
    linkedPageId: p_tomcat.id, discoveredAt: t(0, 9, 22), createdAt, updatedAt: createdAt,
  };

  const p_mssql = makeNodePage('MSSQL on DB-01', '');
  const mssqlSvc: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'service',
    label: 'MSSQL 2019 (1433)', position: { x: 500, y: 200 },
    data: { name: 'Microsoft SQL Server', version: '2019', port: 1433, cves: [] },
    linkedPageId: p_mssql.id, discoveredAt: t(0, 9, 30), createdAt, updatedAt: createdAt,
  };

  const p_smb = makeNodePage('SMB on FILE-01', '');
  const smbSvc: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'service',
    label: 'SMB (445)', position: { x: 50, y: 500 },
    data: { name: 'SMB', version: '3.1.1', port: 445, cves: ['CVE-2017-0144'] },
    linkedPageId: p_smb.id, discoveredAt: t(0, 9, 38), createdAt, updatedAt: createdAt,
  };

  // ── Credentials (5) ────────────────────────────────────────
  const p_jsmith = makeNodePage('j.smith credential', '');
  const jsmith: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'credential',
    label: 'j.smith', position: { x: 50, y: 650 },
    data: { username: 'ACME\\j.smith', secret: 'Summer2024!', source: 'Password Spray' },
    linkedPageId: p_jsmith.id, discoveredAt: t(0, 16, 30), createdAt, updatedAt: createdAt,
  };

  const p_svcweb = makeNodePage('svc_web credential', '');
  const svcweb: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'credential',
    label: 'svc_web', position: { x: 250, y: 600 },
    data: { username: 'ACME\\svc_web', secret: 'aad3b435:e19ccf75ee54e06b', source: 'Kerberoasting (RC4)' },
    linkedPageId: p_svcweb.id, discoveredAt: t(1, 14, 30), createdAt, updatedAt: createdAt,
  };

  const p_adminsql = makeNodePage('admin_sql credential', '');
  const adminsql: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'credential',
    label: 'admin_sql (sa)', position: { x: 500, y: 600 },
    data: { username: 'sa', secret: 'Adm1n$ql!2023', source: 'Mimikatz (LSASS dump on DB-01)' },
    linkedPageId: p_adminsql.id, discoveredAt: t(2, 11, 0), createdAt, updatedAt: createdAt,
  };

  const p_svcbackup = makeNodePage('svc_backup credential', '');
  const svcbackup: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'credential',
    label: 'svc_backup', position: { x: 700, y: 650 },
    data: { username: 'ACME\\svc_backup', secret: 'B@ckup_2023!', source: 'GPP cpassword (SYSVOL)' },
    linkedPageId: p_svcbackup.id, discoveredAt: t(2, 9, 30), createdAt, updatedAt: createdAt,
  };

  const p_daadmin = makeNodePage('Domain Admin credential', '');
  const daadmin: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'credential',
    label: 'ACME\\Administrator', position: { x: 450, y: 1100 },
    data: { username: 'ACME\\Administrator', secret: 'NTLM: 8846f7eaee8fb117ad06bdd830b7586c', source: 'DCSync via svc_backup' },
    linkedPageId: p_daadmin.id, discoveredAt: t(3, 13, 0), createdAt, updatedAt: createdAt,
  };

  // ── Pivots (3) ─────────────────────────────────────────────
  const p_piv1 = makeNodePage('Pivot: PsExec to FILE-01', '');
  const pivotPsexec: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'pivot',
    label: 'PsExec → FILE-01', position: { x: 100, y: 800 },
    data: { description: 'Lateral movement via PsExec using svc_web NTLM hash from WEB-01 to FILE-01' },
    linkedPageId: p_piv1.id, discoveredAt: t(2, 10, 30), createdAt, updatedAt: createdAt,
  };

  const p_piv2 = makeNodePage('Pivot: WinRM to DC-01', '');
  const pivotWinrm: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'pivot',
    label: 'WinRM → DC-01', position: { x: 350, y: 800 },
    data: { description: 'WinRM lateral movement using svc_backup credentials from FILE-01 to DC-01' },
    linkedPageId: p_piv2.id, discoveredAt: t(3, 9, 0), createdAt, updatedAt: createdAt,
  };

  const p_piv3 = makeNodePage('Pivot: MSSQL Link to APP-01', '');
  const pivotMssql: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'pivot',
    label: 'MSSQL Link → APP-01', position: { x: 650, y: 800 },
    data: { description: 'MSSQL linked server exploitation from DB-01 to execute commands on APP-01 via xp_cmdshell' },
    linkedPageId: p_piv3.id, discoveredAt: t(2, 14, 30), createdAt, updatedAt: createdAt,
  };

  // ── Findings – Critical (3) ────────────────────────────────
  const p_f1 = makeNodePage('Domain Admin via Kerberoasting', '');
  const f1: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Domain Admin via Kerberoasting', position: { x: 150, y: 1150 },
    data: { ...defaultFindingData(), title: 'Kerberoastable SPN on svc_web service account with Domain Admin privileges allows offline password cracking and full domain compromise', severity: 'critical', cvss: 9.8 },
    linkedPageId: p_f1.id, discoveredAt: t(3, 15, 30), createdAt, updatedAt: createdAt,
  };

  const p_f2 = makeNodePage('Unconstrained Delegation on WEB-01', '');
  const f2: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Unconstrained Delegation', position: { x: 400, y: 100 },
    data: { ...defaultFindingData(), title: 'WEB-01 configured with unconstrained Kerberos delegation allowing TGT theft of any authenticating user including Domain Admins', severity: 'critical', cvss: 9.1 },
    linkedPageId: p_f2.id, discoveredAt: t(1, 13, 0), createdAt, updatedAt: createdAt,
  };

  const p_f3 = makeNodePage('DCSync Rights for svc_backup', '');
  const f3: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'DCSync Rights – svc_backup', position: { x: 600, y: 1150 },
    data: { ...defaultFindingData(), title: 'svc_backup has Replicating Directory Changes and Replicating Directory Changes All rights enabling DCSync attack for all domain password hashes', severity: 'critical', cvss: 9.8 },
    linkedPageId: p_f3.id, discoveredAt: t(3, 10, 30), createdAt, updatedAt: createdAt,
  };

  // ── Findings – High (5) ────────────────────────────────────
  const p_f4 = makeNodePage('SQL Injection in Inventory App', '');
  const f4: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'SQL Injection – Inventory App', position: { x: 900, y: 300 },
    data: { ...defaultFindingData(), title: 'Blind SQL injection in /api/inventory endpoint on WEB-02 allows database extraction and OS command execution via xp_cmdshell', severity: 'high', cvss: 8.6 },
    linkedPageId: p_f4.id, discoveredAt: t(1, 10, 30), createdAt, updatedAt: createdAt,
  };

  const p_f5 = makeNodePage('LLMNR/NBT-NS Poisoning', '');
  const f5: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'LLMNR/NBT-NS Poisoning', position: { x: 350, y: 200 },
    data: { ...defaultFindingData(), title: 'LLMNR and NBT-NS broadcast protocols enabled on internal subnet allowing NTLMv2 hash capture via Responder', severity: 'high', cvss: 8.0 },
    linkedPageId: p_f5.id, discoveredAt: t(0, 14, 0), createdAt, updatedAt: createdAt,
  };

  const p_f6 = makeNodePage('Weak Kerberos Encryption (RC4)', '');
  const f6: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Weak Kerberos Encryption (RC4)', position: { x: 100, y: 1050 },
    data: { ...defaultFindingData(), title: 'Domain permits RC4_HMAC_MD5 etype for Kerberos making Kerberoast and AS-REP roast attacks practical with GPU cracking', severity: 'high', cvss: 7.5 },
    linkedPageId: p_f6.id, discoveredAt: t(1, 15, 30), createdAt, updatedAt: createdAt,
  };

  const p_f7 = makeNodePage('LAPS Not Deployed', '');
  const f7: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'LAPS Not Deployed', position: { x: 500, y: 1050 },
    data: { ...defaultFindingData(), title: 'Local Administrator Password Solution (LAPS) is not deployed resulting in shared local admin password across all member servers and workstations', severity: 'high', cvss: 7.8 },
    linkedPageId: p_f7.id, discoveredAt: t(2, 13, 0), createdAt, updatedAt: createdAt,
  };

  const p_f8 = makeNodePage('Cleartext GPP Passwords', '');
  const f8: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Cleartext GPP Passwords', position: { x: 850, y: 550 },
    data: { ...defaultFindingData(), title: 'Group Policy Preferences in SYSVOL contain AES-256 encrypted credentials (cpassword) decryptable by any domain user via published Microsoft key', severity: 'high', cvss: 7.9 },
    linkedPageId: p_f8.id, discoveredAt: t(2, 9, 0), createdAt, updatedAt: createdAt,
  };

  // ── Findings – Medium (4) ──────────────────────────────────
  const p_f9 = makeNodePage('SMB Signing Disabled', '');
  const f9: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'SMB Signing Disabled', position: { x: 200, y: 450 },
    data: { ...defaultFindingData(), title: 'SMB message signing is not required on FILE-01 and DB-01 enabling NTLM relay attacks', severity: 'medium', cvss: 5.9 },
    linkedPageId: p_f9.id, discoveredAt: t(2, 10, 0), createdAt, updatedAt: createdAt,
  };

  const p_f10 = makeNodePage('Unrestricted Outbound Access', '');
  const f10: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Unrestricted Outbound Access', position: { x: 900, y: 50 },
    data: { ...defaultFindingData(), title: 'Internal servers have unrestricted outbound internet access on all ports enabling data exfiltration and C2 communication', severity: 'medium', cvss: 6.5 },
    linkedPageId: p_f10.id, discoveredAt: t(1, 10, 0), createdAt, updatedAt: createdAt,
  };

  const p_f11 = makeNodePage('Weak Domain Password Policy', '');
  const f11: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Weak Domain Password Policy', position: { x: 50, y: 1150 },
    data: { ...defaultFindingData(), title: 'Default domain password policy requires only 8 characters with no complexity requirements enabling successful password spray attacks', severity: 'medium', cvss: 5.5 },
    linkedPageId: p_f11.id, discoveredAt: t(1, 11, 30), createdAt, updatedAt: createdAt,
  };

  const p_f12 = makeNodePage('No MFA on Remote Access', '');
  const f12: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'No MFA on Remote Access', position: { x: 1100, y: 350 },
    data: { ...defaultFindingData(), title: 'VPN and Outlook Web Access (OWA) do not enforce multi-factor authentication allowing credential-stuffing attacks', severity: 'medium', cvss: 6.8 },
    linkedPageId: p_f12.id, discoveredAt: t(1, 8, 45), createdAt, updatedAt: createdAt,
  };

  // ── Findings – Low (2) ─────────────────────────────────────
  const p_f13 = makeNodePage('SNMP Default Community String', '');
  const f13: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'SNMP Default Community String', position: { x: -100, y: 450 },
    data: { ...defaultFindingData(), title: 'FILE-01 responds to SNMP queries using the default "public" community string disclosing system information', severity: 'low', cvss: 3.5 },
    linkedPageId: p_f13.id, discoveredAt: t(0, 10, 0), createdAt, updatedAt: createdAt,
  };

  const p_f14 = makeNodePage('DNS Zone Transfer Allowed', '');
  const f14: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'DNS Zone Transfer Allowed', position: { x: 500, y: 850 },
    data: { ...defaultFindingData(), title: 'DC-01 permits unrestricted DNS zone transfers (AXFR) exposing all internal DNS records', severity: 'low', cvss: 3.1 },
    linkedPageId: p_f14.id, discoveredAt: t(0, 10, 30), createdAt, updatedAt: createdAt,
  };

  // ── Findings – Info (2) ────────────────────────────────────
  const p_f15 = makeNodePage('Internal IP Address Disclosure', '');
  const f15: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Internal IP Address Disclosure', position: { x: 550, y: 50 },
    data: { ...defaultFindingData(), title: 'IIS and Tomcat response headers disclose internal RFC1918 IP addresses to unauthenticated users', severity: 'info', cvss: 0.0 },
    linkedPageId: p_f15.id, discoveredAt: t(0, 11, 45), createdAt, updatedAt: createdAt,
  };

  const p_f16 = makeNodePage('Service Version Enumeration', '');
  const f16: GraphNode = {
    id: uuidv4(), graphId: internalGraph.id, type: 'finding',
    label: 'Service Version Enumeration', position: { x: 700, y: 400 },
    data: { ...defaultFindingData(), title: 'Multiple services expose detailed version banners (MSSQL, IIS, Tomcat, SMB) aiding targeted exploit selection', severity: 'info', cvss: 0.0 },
    linkedPageId: p_f16.id, discoveredAt: t(0, 11, 15), createdAt, updatedAt: createdAt,
  };

  // ════════════════════════════════════════════════════════════
  //  EXTERNAL PERIMETER GRAPH – Nodes
  // ════════════════════════════════════════════════════════════

  const p_dmzweb = makeNodePage('DMZ-WEB', '');
  const dmzweb: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'host',
    label: 'DMZ-WEB (10.0.0.10)', position: { x: 200, y: 0 },
    data: { hostname: 'DMZ-WEB', ip: '10.0.0.10', os: 'Windows Server 2016', openPorts: [80, 443, 445, 3389] },
    linkedPageId: p_dmzweb.id, discoveredAt: t(0, 9, 0), createdAt, updatedAt: createdAt,
  };

  const p_ex01 = makeNodePage('EX-01 (Exchange)', '');
  const ex01: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'host',
    label: 'EX-01 (10.0.0.20)', position: { x: 550, y: 0 },
    data: { hostname: 'EX-01', ip: '10.0.0.20', os: 'Windows Server 2019', openPorts: [25, 443, 587] },
    linkedPageId: p_ex01.id, discoveredAt: t(0, 9, 5), createdAt, updatedAt: createdAt,
  };

  const p_httpsSvc = makeNodePage('HTTPS on DMZ-WEB', '');
  const httpsSvc: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'service',
    label: 'HTTPS (443)', position: { x: 100, y: 200 },
    data: { name: 'HTTPS / IIS', version: '10.0', port: 443, cves: [] },
    linkedPageId: p_httpsSvc.id, discoveredAt: t(0, 9, 45), createdAt, updatedAt: createdAt,
  };

  // ── External Findings (4) ──────────────────────────────────
  const p_f17 = makeNodePage('MS17-010 EternalBlue on DMZ', '');
  const f17: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'finding',
    label: 'MS17-010 EternalBlue', position: { x: 350, y: 200 },
    data: { ...defaultFindingData(), title: 'DMZ web server vulnerable to MS17-010 (EternalBlue) allowing unauthenticated remote code execution as SYSTEM', severity: 'critical', cvss: 9.8 },
    linkedPageId: p_f17.id, discoveredAt: t(1, 13, 0), createdAt, updatedAt: createdAt,
  };

  const p_f18 = makeNodePage('Unpatched Exchange ProxyLogon', '');
  const f18: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'finding',
    label: 'ProxyLogon (CVE-2021-26855)', position: { x: 650, y: 200 },
    data: { ...defaultFindingData(), title: 'Exchange server EX-01 is vulnerable to ProxyLogon (CVE-2021-26855) enabling pre-authentication remote code execution', severity: 'high', cvss: 8.8 },
    linkedPageId: p_f18.id, discoveredAt: t(1, 15, 0), createdAt, updatedAt: createdAt,
  };

  const p_f19 = makeNodePage('Outdated TLS 1.0/1.1 Enabled', '');
  const f19: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'finding',
    label: 'Outdated TLS 1.0/1.1', position: { x: 100, y: 400 },
    data: { ...defaultFindingData(), title: 'DMZ web server supports deprecated TLS 1.0 and TLS 1.1 protocols vulnerable to POODLE and BEAST attacks', severity: 'medium', cvss: 5.3 },
    linkedPageId: p_f19.id, discoveredAt: t(0, 10, 30), createdAt, updatedAt: createdAt,
  };

  const p_f20 = makeNodePage('Missing HTTP Security Headers', '');
  const f20: GraphNode = {
    id: uuidv4(), graphId: externalGraph.id, type: 'finding',
    label: 'Missing HTTP Security Headers', position: { x: 400, y: 400 },
    data: { ...defaultFindingData(), title: 'Web application is missing X-Frame-Options, Content-Security-Policy, and Strict-Transport-Security headers', severity: 'low', cvss: 3.3 },
    linkedPageId: p_f20.id, discoveredAt: t(0, 11, 0), createdAt, updatedAt: createdAt,
  };

  // ════════════════════════════════════════════════════════════
  //  EDGES – Internal Graph
  // ════════════════════════════════════════════════════════════
  const e = (src: GraphNode, tgt: GraphNode, edgeType: EdgeType, label: string): GraphEdge => ({
    id: uuidv4(), graphId: internalGraph.id,
    sourceNodeId: src.id, targetNodeId: tgt.id,
    edgeType, label, linkedPageId: null, createdAt, updatedAt: createdAt,
  });

  const internalEdges: GraphEdge[] = [
    // Host → Service relationships
    e(web01, iis, 'HasSession', 'IIS Web Service'),
    e(web02, tomcat, 'HasSession', 'Tomcat Service'),
    e(db01, mssqlSvc, 'HasSession', 'MSSQL Service'),
    e(file01, smbSvc, 'HasSession', 'SMB Service'),

    // Initial access & credential discovery
    e(web01, jsmith, 'HasSession', 'Password Spray'),
    e(web01, svcweb, 'Exploits', 'Kerberoasting'),
    e(tomcat, db01, 'Exploits', 'SQLi → xp_cmdshell'),
    e(db01, adminsql, 'HasSession', 'Mimikatz LSASS'),
    e(file01, svcbackup, 'HasSession', 'GPP cpassword'),
    e(jsmith, mail01, 'HasSession', 'OWA Login'),

    // Lateral movement pivots
    e(svcweb, pivotPsexec, 'PivotsTo', 'PsExec'),
    e(pivotPsexec, file01, 'PivotsTo', 'Lateral Move'),
    e(adminsql, pivotMssql, 'PivotsTo', 'MSSQL Link'),
    e(pivotMssql, app01, 'PivotsTo', 'xp_cmdshell'),
    e(svcbackup, pivotWinrm, 'PivotsTo', 'WinRM Session'),
    e(pivotWinrm, dc01, 'PivotsTo', 'Domain Controller'),

    // Domain compromise
    e(dc01, daadmin, 'HasSession', 'DCSync'),
    e(daadmin, dc02, 'AdminTo', 'Domain Admin'),
    e(daadmin, jump01, 'AdminTo', 'Domain Admin'),

    // Finding relationships (host/service → finding)
    e(web01, f2, 'Exploits', 'Unconstrained Delegation'),
    e(web01, f5, 'Exploits', 'LLMNR Poisoning'),
    e(web01, f10, 'Exploits', 'Egress Test'),
    e(web01, f15, 'Exploits', 'Header Leak'),
    e(tomcat, f4, 'Exploits', 'SQL Injection'),
    e(file01, f9, 'Exploits', 'SMB Signing Check'),
    e(file01, f13, 'Exploits', 'SNMP Enum'),
    e(smbSvc, f8, 'Exploits', 'SYSVOL cpassword'),
    e(mssqlSvc, f16, 'Exploits', 'Banner Grab'),
    e(mail01, f12, 'Exploits', 'No MFA'),
    e(dc01, f1, 'Exploits', 'Kerberoast → DA'),
    e(dc01, f3, 'Exploits', 'Replication Rights'),
    e(dc01, f6, 'Exploits', 'Kerberos Config'),
    e(dc01, f7, 'Exploits', 'No LAPS'),
    e(dc01, f11, 'Exploits', 'Policy Check'),
    e(dc01, f14, 'Exploits', 'Zone Transfer'),
  ];

  // ════════════════════════════════════════════════════════════
  //  EDGES – External Graph
  // ════════════════════════════════════════════════════════════
  const ex = (src: GraphNode, tgt: GraphNode, edgeType: EdgeType, label: string): GraphEdge => ({
    id: uuidv4(), graphId: externalGraph.id,
    sourceNodeId: src.id, targetNodeId: tgt.id,
    edgeType, label, linkedPageId: null, createdAt, updatedAt: createdAt,
  });

  const externalEdges: GraphEdge[] = [
    ex(dmzweb, httpsSvc, 'HasSession', 'HTTPS Service'),
    ex(dmzweb, f17, 'Exploits', 'MS17-010'),
    ex(dmzweb, f20, 'Exploits', 'Header Audit'),
    ex(ex01, f18, 'Exploits', 'ProxyLogon'),
    ex(httpsSvc, f19, 'Exploits', 'TLS Audit'),
  ];

  // ════════════════════════════════════════════════════════════
  //  Write to DB
  // ════════════════════════════════════════════════════════════
  const allInternalNodes: GraphNode[] = [
    web01, web02, db01, file01, mail01, app01, dc01, dc02, jump01,
    iis, tomcat, mssqlSvc, smbSvc,
    jsmith, svcweb, adminsql, svcbackup, daadmin,
    pivotPsexec, pivotWinrm, pivotMssql,
    f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16,
  ];

  const allExternalNodes: GraphNode[] = [
    dmzweb, ex01, httpsSvc,
    f17, f18, f19, f20,
  ];

  await db.transaction('rw', [db.workspaces, db.pages, db.graphs, db.graphNodes, db.graphEdges], async () => {
    await db.workspaces.add(workspace);
    await db.pages.bulkAdd([engagementPage, reconPage, methodologyPage, findingsPage, remediationPage, ...nodePages]);
    await db.graphs.add(internalGraph);
    await db.graphs.add(externalGraph);
    await db.graphNodes.bulkAdd([...allInternalNodes, ...allExternalNodes]);
    await db.graphEdges.bulkAdd([...internalEdges, ...externalEdges]);
  });
}
