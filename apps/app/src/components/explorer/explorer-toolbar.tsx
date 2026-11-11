import { EXPORT_FORMAT_LABELS, EXPORT_ID_HEADER, type QueryLang } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@logbird/ui/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@logbird/ui/components/ui/dropdown-menu';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BookmarkPlusIcon, CircleAlertIcon, Columns3Icon, DownloadIcon, Loader2Icon, MoreHorizontalIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { DisabledReason } from '@/components/admin-gate';
import { HighlightedText } from '@/components/query-input/highlighted';
import { ViewLabelChips } from '@/components/views/view-label-chips';
import { api, langParam } from '@/lib/api/client';
import { errorMessage, toApiError } from '@/lib/api/errors';
import { keys } from '@/lib/api/queries';
import { fieldErrorMessage } from '@/lib/forms';
import { rangeLabel, resolveRange } from '@/lib/range';
import { useCopyViewLink, useResolvedViewLabels } from '@/lib/views';
import { DEFAULT_COLUMNS, EVENT_COLUMNS } from './columns';
import { exportFailureDescription } from './export-error';

export function ColumnPicker({ columns, onChange }: { columns: string[]; onChange: (cols: string[]) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button aria-label="Choose columns" size="sm" variant="outline" />}>
        <Columns3Icon />
        <span className="hidden xl:inline">Columns</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wider">Visible columns</DropdownMenuLabel>
          {EVENT_COLUMNS.map((c) => (
            <DropdownMenuCheckboxItem
              checked={columns.includes(c.id)}
              closeOnClick={false}
              disabled={c.required}
              key={c.id}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? EVENT_COLUMNS.filter((x) => x.id === c.id || columns.includes(x.id)).map((x) => x.id)
                    : columns.filter((id) => id !== c.id),
                )
              }
            >
              {c.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onChange(DEFAULT_COLUMNS)}>Reset to default</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ExportFormat = import('@logbird/contracts').ExportFormat;
const EXPORT_FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'jsonl-evidence', label: EXPORT_FORMAT_LABELS['jsonl-evidence'], hint: 'Original stored events with provenance. Use as evidence.' },
  { format: 'csv', label: EXPORT_FORMAT_LABELS.csv, hint: 'Every normalized field; long values shortened.' },
  { format: 'jsonl', label: EXPORT_FORMAT_LABELS.jsonl, hint: 'Every normalized field; long values shortened.' },
];

/** Downloads every match of the range and query as CSV or JSON Lines (the toolbar menu and the mobile menu share it). */
function useExport({ projectId, range, q, lang = 'query' }: { projectId: string; range: string; q: string; lang?: QueryLang }) {
  const [busy, setBusy] = useState(false);
  const download = async (format: ExportFormat) => {
    setBusy(true);
    const controller = new AbortController();
    const cancel = { label: 'Cancel', onClick: () => controller.abort() };
    const notice = toast.loading('Preparing export\u2026', {
      cancel,
    });
    const waiting = setTimeout(
      () =>
        toast.loading('Preparing export \u2014 waiting for server', {
          id: notice,
          description: 'Active writes can delay preparation by up to 30 seconds.',
          cancel,
        }),
      1000,
    );
    let exportId: string | null = null;
    let reading = false;
    try {
      const r = resolveRange(range);
      const response = await fetch(
        api.events.exportUrl(projectId, { from: r.from, to: r.to, q: q || undefined, lang: q ? langParam(lang) : undefined, format }),
        { signal: controller.signal },
      );
      if (!response.ok) throw await toApiError(response);
      exportId = response.headers.get(EXPORT_ID_HEADER);
      if (!exportId || !/^[a-f0-9-]{36}$/.test(exportId)) throw new Error('Export response is missing its record identifier.');
      clearTimeout(waiting);
      toast.loading(`Downloading export ${exportId.slice(0, 8)}\u2026`, { id: notice, description: undefined, cancel });
      reading = true;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logbird-events-${exportId}${format === 'jsonl-evidence' ? '-evidence' : ''}.${format === 'csv' ? 'csv' : 'jsonl'}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${EXPORT_FORMATS.find((f) => f.format === format)?.label ?? format} ready`, {
        id: notice,
        cancel: null,
        description: `${rangeLabel(range)}${q ? ` · ${q}` : ''}`,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        toast.dismiss(notice);
        toast.info('Export canceled', {
          description: exportId ? `Export ${exportId.slice(0, 8)} was canceled.` : undefined,
        });
        return;
      }
      const failedId = exportId;
      const description =
        reading && failedId ? await exportFailureDescription(failedId, (signal) => api.exportStatus(failedId, signal)) : errorMessage(error);
      toast.error('Export failed', { id: notice, cancel: null, description });
    } finally {
      clearTimeout(waiting);
      setBusy(false);
    }
  };
  return { busy, download };
}

export function ExportMenu({
  projectId,
  range,
  q,
  lang = 'query',
  disabledReason,
}: {
  projectId: string;
  range: string;
  q: string;
  lang?: QueryLang;
  /** Why there is nothing valid to export (e.g. the query is rejected). Disables the menu and explains on hover. */
  disabledReason?: string | null;
}) {
  const { busy, download } = useExport({ projectId, range, q, lang });
  return (
    <DisabledReason reason={disabledReason}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={disabledReason ? `Export: ${disabledReason}` : 'Export'}
              data-testid="export-menu"
              disabled={busy || Boolean(disabledReason)}
              size="sm"
              variant="outline"
            />
          }
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
          <span className="hidden xl:inline">Export</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              Exports every match in the current range and query.
            </DropdownMenuLabel>
            {EXPORT_FORMATS.map((f) => (
              <DropdownMenuItem key={f.format} onClick={() => download(f.format)}>
                <DownloadIcon />
                <span className="flex flex-col gap-0.5">
                  <span>{f.label}</span>
                  <span className="text-muted-foreground text-xs">{f.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<a href="https://github.com/joodlab/logbird/blob/master/docs/exports.md" rel="noreferrer" target="_blank" />}>
            Which format? (GitHub ↗)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </DisabledReason>
  );
}

/**
 * Below `md` the toolbar has no room for Save view and Export, so one overflow menu offers both, with the same dialog
 * and the same disabled reason. Columns stay desktop-only: phones show the card list, which has no columns.
 */
export function ExplorerOverflowMenu({
  projectId,
  q,
  exportQ,
  lang = 'query',
  range,
  columns,
  disabledReason,
  className,
}: {
  projectId: string;
  /** The query as typed (what a view saves). */
  q: string;
  /** The query that is exported (includes a locked base filter, if any). */
  exportQ: string;
  lang?: QueryLang;
  range: string;
  columns: string[];
  disabledReason?: string | null;
  className?: string;
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const { busy, download } = useExport({ projectId, range, q: exportQ, lang });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button aria-label="More actions" className={className} data-testid="explorer-more" size="icon-sm" variant="outline" />}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <MoreHorizontalIcon />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {disabledReason ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-start gap-1.5 font-normal text-muted-foreground text-xs" data-testid="explorer-more-reason">
                <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
                {disabledReason}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
          ) : null}
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={Boolean(disabledReason)} onClick={() => setSaveOpen(true)}>
              <BookmarkPlusIcon />
              Save view…
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">Export every match</DropdownMenuLabel>
            {EXPORT_FORMATS.map((f) => (
              <DropdownMenuItem disabled={busy || Boolean(disabledReason)} key={f.format} onClick={() => download(f.format)}>
                <DownloadIcon />
                <span className="flex flex-col gap-0.5">
                  <span>{f.label}</span>
                  <span className="text-muted-foreground text-xs">{f.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<a href="https://github.com/joodlab/logbird/blob/master/docs/exports.md" rel="noreferrer" target="_blank" />}>
            Which format? (GitHub ↗)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SaveViewDialog
        columns={columns}
        lang={lang}
        onOpenChange={setSaveOpen}
        open={saveOpen && !disabledReason}
        projectId={projectId}
        q={q}
        range={range}
      />
    </>
  );
}

const nameSchema = z.string().trim().min(1, 'Name the view.').max(80);

export function SaveViewButton({
  projectId,
  q,
  lang = 'query',
  range,
  columns,
  disabledReason,
}: {
  projectId: string;
  q: string;
  lang?: QueryLang;
  range: string;
  columns: string[];
  /** Why the current state cannot be saved (e.g. the query is rejected). Disables the button and explains on hover. */
  disabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DisabledReason reason={disabledReason}>
        <Button
          aria-label={disabledReason ? `Save view: ${disabledReason}` : undefined}
          data-testid="save-view"
          disabled={Boolean(disabledReason)}
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          <BookmarkPlusIcon />
          <span className="hidden xl:inline">Save view</span>
        </Button>
      </DisabledReason>
      <SaveViewDialog columns={columns} lang={lang} onOpenChange={setOpen} open={open && !disabledReason} projectId={projectId} q={q} range={range} />
    </>
  );
}

/** Names and saves the current explorer state (query, mode, range, columns) as a workspace-wide view. */
function SaveViewDialog({
  projectId,
  q,
  lang = 'query',
  range,
  columns,
  open,
  onOpenChange,
}: {
  projectId: string;
  q: string;
  lang?: QueryLang;
  range: string;
  columns: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const copyLink = useCopyViewLink();
  // "Tenant: Bayt Al Rimal" instead of tenant:biz_5, in this dialog and on the saved view's card.
  const labels = useResolvedViewLabels(projectId, q, lang, open);
  const create = useMutation({
    mutationFn: (value: { name: string; description: string }) =>
      api.views.create(projectId, {
        name: value.name.trim(),
        description: value.description.trim() || null,
        state: { q, lang, range, columns, ...(labels.length ? { labels } : {}) },
      }),
    onSuccess: async (view) => {
      await queryClient.invalidateQueries({ queryKey: [...keys.project(projectId), 'views'] });
      onOpenChange(false);
      form.reset();
      toast.success(`Saved “${view.name}”`, {
        description: 'It is in the sidebar for everyone in the workspace.',
        action: { label: 'Copy link', onClick: () => copyLink(projectId, view) },
      });
      navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, view: view.id })) as never, replace: true });
    },
  });
  const form = useForm({
    defaultValues: { name: '', description: '' },
    onSubmit: ({ value }) => create.mutateAsync(value).catch(() => undefined),
  });
  return (
    <Dialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          form.reset();
          create.reset();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Saves the query, its mode, the time range and visible columns. Everyone in the workspace can open it.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-[12px]">
            <ViewLabelChips className="mb-1.5" labels={labels} lang={lang} q={q} />
            <div className="flex min-w-0 items-center gap-2">
              {lang === 'sql' ? <SqlBadge /> : null}
              <span className="truncate">
                {q ? <HighlightedText lang={lang} value={q} /> : <span className="text-muted-foreground">All events</span>}
              </span>
            </div>
            <div className="mt-0.5 font-sans text-muted-foreground text-xs">
              {rangeLabel(range)} · {columns.length} columns
            </div>
          </div>
          <form.Field name="name" validators={{ onSubmit: nameSchema }}>
            {(field) => {
              const message = fieldErrorMessage(field.state.meta.errors);
              return (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="view-name">Name</Label>
                  <Input
                    aria-invalid={Boolean(message) || undefined}
                    autoFocus
                    id="view-name"
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Failed CRM syncs"
                    value={field.state.value}
                  />
                  {message ? <p className="text-destructive text-xs">{message}</p> : null}
                </div>
              );
            }}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="view-description">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Textarea className="min-h-16" id="view-description" onChange={(e) => field.handleChange(e.target.value)} value={field.state.value} />
              </div>
            )}
          </form.Field>
          {create.isError ? <p className="text-destructive text-sm">{errorMessage(create.error)}</p> : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button loading={create.isPending} type="submit">
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Marks a saved view (or query) written in SQL mode. */
export function SqlBadge({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded border border-syntax-keyword/30 bg-syntax-keyword/10 px-1 font-mono font-semibold text-[9.5px] text-syntax-keyword tracking-wide ${className ?? ''}`}
    >
      SQL
    </span>
  );
}
