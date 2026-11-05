import { useDebouncedValue } from '@tanstack/react-pacer';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { EntityKind } from '@trailmark/contracts';
import { EntityAvatar } from '@trailmark/ui/components/entity-chip';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@trailmark/ui/components/ui/command';
import { useTheme } from '@trailmark/ui/theme';
import {
  BookmarkIcon,
  FileSearchIcon,
  GitBranchIcon,
  KeyRoundIcon,
  MonitorIcon,
  MoonIcon,
  RocketIcon,
  SearchIcon,
  SunIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api/client';
import { projectsQuery, viewsQuery } from '@/lib/api/queries';
import { ENTITY_SECTIONS, sectionForKind } from '@/lib/entities';
import { PROJECT_NAV } from './nav';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function CommandPalette({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (open: boolean) => void; projectId?: string }) {
  const navigate = useNavigate();
  const { setTheme, resolvedTheme } = useTheme();
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), { wait: 180 });
  const projects = useQuery({ ...projectsQuery(), enabled: open });
  const views = useQuery({ ...viewsQuery(projectId ?? ''), enabled: open && Boolean(projectId) });

  const entities = useQuery({
    queryKey: ['palette-entities', projectId, debounced],
    enabled: open && Boolean(projectId) && debounced.length >= 2,
    queryFn: async ({ signal }) => {
      const kinds: EntityKind[] = ['actor', 'tenant', 'executor', 'target'];
      const results = await Promise.all(
        kinds.map((kind) => api.entities.list(projectId ?? '', { kind, q: debounced, limit: 4 }, signal).catch(() => ({ data: [] }))),
      );
      return results.flatMap((r) => r.data);
    },
    staleTime: 30_000,
  });

  const go = (fn: () => void) => {
    onOpenChange(false);
    setSearch('');
    fn();
  };

  const trimmed = search.trim();
  const looksLikeEvent = ULID_RE.test(trimmed) || /^evt_/.test(trimmed);
  const looksLikeOperation = /^op_/.test(trimmed);

  return (
    <CommandDialog
      className="sm:max-w-xl"
      description="Navigate, jump to an entity, event or operation, switch project or theme."
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setSearch('');
      }}
      open={open}
      title="Command palette"
    >
      <CommandInput onValueChange={setSearch} placeholder="Search pages, actors, tenants, records, or paste an event id…" value={search} />
      <CommandList className="max-h-[min(60vh,28rem)]">
        <CommandEmpty>No matches. Try an id like usr_42 or op_…</CommandEmpty>
        {projectId && trimmed ? (
          <CommandGroup heading="Jump to">
            {looksLikeEvent ? (
              <CommandItem
                onSelect={() =>
                  go(() => navigate({ to: '/p/$projectId/events', params: { projectId }, search: { q: `id:${trimmed}`, ev: trimmed } }))
                }
                value={`event ${trimmed}`}
              >
                <FileSearchIcon />
                Open event <span className="font-mono text-xs">{trimmed}</span>
              </CommandItem>
            ) : null}
            {looksLikeOperation ? (
              <CommandItem
                onSelect={() => go(() => navigate({ to: '/p/$projectId/operations/$operationId', params: { projectId, operationId: trimmed } }))}
                value={`operation ${trimmed}`}
              >
                <GitBranchIcon />
                Open operation <span className="font-mono text-xs">{trimmed}</span>
              </CommandItem>
            ) : null}
            <CommandItem
              onSelect={() => go(() => navigate({ to: '/p/$projectId/events', params: { projectId }, search: { q: trimmed } }))}
              value={`search ${trimmed}`}
            >
              <SearchIcon />
              Search events for <span className="font-mono text-xs">{trimmed}</span>
            </CommandItem>
          </CommandGroup>
        ) : null}
        {entities.data && entities.data.length > 0 ? (
          <CommandGroup heading="Entities">
            {entities.data.map((e) => {
              const section = sectionForKind(e.kind);
              const Icon = ENTITY_SECTIONS[section].icon;
              return (
                <CommandItem
                  key={`${e.kind}:${e.id}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: `/p/$projectId/${section}/$entityId` as '/p/$projectId/actors/$entityId',
                        params: { projectId: projectId ?? '', entityId: e.id },
                      }),
                    )
                  }
                  value={`${e.kind} ${e.id} ${e.name} ${debounced}`}
                >
                  <EntityAvatar icon={e.kind === 'actor' && e.type === 'user' ? undefined : Icon} id={e.id} name={e.name || e.id} size="sm" />
                  <span className="truncate">{e.name || e.id}</span>
                  <span className="truncate font-mono text-muted-foreground text-xs">{e.id}</span>
                  <CommandShortcut>{ENTITY_SECTIONS[section].singular}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {projectId ? (
          <CommandGroup heading="Go to">
            {PROJECT_NAV.flatMap((s) => s.items).map((item) => (
              <CommandItem
                key={item.to}
                keywords={item.keywords?.split(' ')}
                onSelect={() => go(() => navigate({ to: item.to as '/p/$projectId', params: { projectId } }))}
                value={item.label}
              >
                <item.icon />
                {item.label}
              </CommandItem>
            ))}
            <CommandItem
              keywords={['api', 'token', 'secret']}
              onSelect={() => go(() => navigate({ to: '/p/$projectId/settings/keys', params: { projectId } }))}
              value="API keys"
            >
              <KeyRoundIcon />
              API keys
            </CommandItem>
            <CommandItem
              keywords={['invite', 'team', 'teammates', 'link', 'join', 'people']}
              onSelect={() => go(() => navigate({ to: '/p/$projectId/settings/members', params: { projectId } }))}
              value="Members"
            >
              <UsersIcon />
              Members &amp; invites
            </CommandItem>
            <CommandItem
              keywords={['setup', 'quickstart', 'docs', 'sdk', 'onboarding', 'checklist', 'query', 'language', 'help', 'integration', 'guide']}
              onSelect={() => go(() => navigate({ to: '/p/$projectId/setup', params: { projectId } }))}
              value="Setup integration guide"
            >
              <RocketIcon />
              Setup &amp; integration guide
            </CommandItem>
          </CommandGroup>
        ) : null}
        {views.data && views.data.length > 0 ? (
          <CommandGroup heading="Saved views">
            {views.data.map((view) => (
              <CommandItem
                key={view.id}
                onSelect={() =>
                  go(() =>
                    navigate({
                      to: '/p/$projectId/events',
                      params: { projectId: projectId ?? '' },
                      search: {
                        q: view.state.q || undefined,
                        lang: view.state.lang === 'sql' ? ('sql' as const) : undefined,
                        range: view.state.range,
                        cols: view.state.columns?.join(',') || undefined,
                        view: view.id,
                      },
                    }),
                  )
                }
                value={`view ${view.name}`}
              >
                <BookmarkIcon />
                {view.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {projects.data && projects.data.length > 1 ? (
          <CommandGroup heading="Switch project">
            {projects.data.map((p) => (
              <CommandItem
                key={p.id}
                onSelect={() => go(() => navigate({ to: '/p/$projectId', params: { projectId: p.id } }))}
                value={`project ${p.name}`}
              >
                <EntityAvatar id={p.id} name={p.name} size="sm" square />
                {p.name}
                {p.id === projectId ? <CommandShortcut>current</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandSeparator />
        <CommandGroup heading="Theme">
          <CommandItem onSelect={() => go(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))} value="toggle theme dark light">
            {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
            Switch to {resolvedTheme === 'dark' ? 'light' : 'dark'} theme
          </CommandItem>
          <CommandItem onSelect={() => go(() => setTheme('system'))} value="system theme">
            <MonitorIcon />
            Use system theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
