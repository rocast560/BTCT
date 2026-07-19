import { useAppStore } from '@/stores';
import { Command } from 'cmdk';
import { useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { FileText, FileType2, Network, Plus, Settings, Users, Sparkles } from 'lucide-react';

export function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    pages,
    graphs,
    openTab,
    createPage,
    createGraph,
    activeWorkspaceId,
    toggleDarkMode,
    setFollowPanelOpen,
  } = useAppStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (commandPaletteOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [commandPaletteOpen]);

  if (!commandPaletteOpen) return null;

  const visiblePages = pages.filter((p) => !p.isGraphPage);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={() => setCommandPaletteOpen(false)}>
      <div className="fixed inset-0 bg-black/50" />
      <div className="relative z-10 w-[520px] overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <Command label="Command palette" className="flex flex-col">
          <div className="flex items-center border-b border-[hsl(var(--border))] px-3">
            <Command.Input
              ref={inputRef}
              placeholder="Type a command or search..."
              className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))]"
            />
          </div>
          <Command.List className="max-h-[300px] overflow-y-auto p-2">
            <Command.Empty className="p-4 text-center text-sm text-[hsl(var(--muted-foreground))]">No results found.</Command.Empty>

            <Command.Group heading="Actions" className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-[hsl(var(--muted-foreground))]">
              <Command.Item
                onSelect={async () => {
                  if (!activeWorkspaceId) return;
                  const page = await createPage(null, 'Untitled');
                  openTab({ id: uuidv4(), kind: 'page', entityId: page.id, title: page.title });
                  setCommandPaletteOpen(false);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
              >
                <Plus size={14} /> New Page
              </Command.Item>
              <Command.Item
                onSelect={async () => {
                  if (!activeWorkspaceId) return;
                  const graph = await createGraph('New Attack Narrative');
                  openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
                  setCommandPaletteOpen(false);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
              >
                <Plus size={14} /> New Attack Narrative
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  if (!activeWorkspaceId) return;
                  openTab({ id: uuidv4(), kind: 'typst', entityId: 'typst', title: 'Typst' });
                  setCommandPaletteOpen(false);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
              >
                <FileType2 size={14} /> Open Typst Document
              </Command.Item>
              <Command.Item
                onSelect={() => { openTab({ id: uuidv4(), kind: 'ai', entityId: 'ai', title: 'Claude' }); setCommandPaletteOpen(false); }}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
              >
                <Sparkles size={14} /> Ask Claude (AI Assistant)
              </Command.Item>
              <Command.Item
                onSelect={() => { setFollowPanelOpen(true); setCommandPaletteOpen(false); }}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
              >
                <Users size={14} /> Active Users / Follow
              </Command.Item>
              <Command.Item
                onSelect={() => { toggleDarkMode(); setCommandPaletteOpen(false); }}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
              >
                <Settings size={14} /> Toggle Dark Mode
              </Command.Item>
            </Command.Group>

            {visiblePages.length > 0 && (
              <Command.Group heading="Pages" className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-[hsl(var(--muted-foreground))]">
                {visiblePages.map((page) => (
                  <Command.Item
                    key={page.id}
                    value={page.title}
                    onSelect={() => {
                      openTab({ id: uuidv4(), kind: 'page', entityId: page.id, title: page.title });
                      setCommandPaletteOpen(false);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
                  >
                    <FileText size={14} />{page.icon ? <span>{page.icon}</span> : null} {page.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {graphs.length > 0 && (
              <Command.Group heading="Attack Narratives" className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-[hsl(var(--muted-foreground))]">
                {graphs.map((graph) => (
                  <Command.Item
                    key={graph.id}
                    value={graph.name}
                    onSelect={() => {
                      openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
                      setCommandPaletteOpen(false);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm aria-selected:bg-[hsl(var(--accent))]"
                  >
                    <Network size={14} /> {graph.name}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
