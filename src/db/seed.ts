import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import { getSharedDoc, seedMissingYTexts } from '@/realtime/shared-doc';
import type { Workspace, Page } from '@/types';

const DEMO_WORKSPACE_NAME = 'ACME Corp Engagement';

/**
 * Engagement week: Monday April 13 -> Friday April 17, 2026.
 * `day` = 0 (Mon) ... 4 (Fri). `hour`/`minute` are local (24h).
 */
function t(day: number, hour: number, minute = 0): number {
  return new Date(2026, 3, 13 + day, hour, minute, 0).getTime();
}

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

  await db.transaction('rw', [db.workspaces, db.pages], async () => {
    await db.workspaces.add(workspace);
    await db.pages.bulkAdd([engagementPage, reconPage, methodologyPage, findingsPage, remediationPage]);
  });
  // The records above went in as plain JSON; give every collaborative field
  // its Y.Text now (invariant #1) or the first rename after seeding is lost.
  seedMissingYTexts(getSharedDoc());
}
