import { FileEdit, Trash2 } from "lucide-react";
import { Card } from "@/components/Card";
import { useDeleteDraft, useSeedDrafts } from "@/api/hooks";
import { useUIStore } from "@/store/uiStore";

interface DraftListProps {
  activeDraftId?: string;
  onSelect?: (id: string) => void;
}

export function DraftList({ activeDraftId, onSelect }: DraftListProps) {
  const drafts = useSeedDrafts();
  const del = useDeleteDraft();
  const pushToast = useUIStore((s) => s.pushToast);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <FileEdit className="h-4 w-4 text-slate-500" /> Drafts
        </span>
      }
    >
      {drafts.isLoading ? (
        <p className="text-xs text-slate-500">Loading...</p>
      ) : !drafts.data || drafts.data.length === 0 ? (
        <p className="text-xs text-slate-500">No drafts yet. Auto-saves every 2s.</p>
      ) : (
        <ul className="flex max-h-[35vh] flex-col gap-1 overflow-y-auto">
          {drafts.data.map((d) => (
            <li
              key={d.id}
              className={`group flex items-start gap-2 rounded-lg p-2 text-xs hover:bg-slate-50 ${
                activeDraftId === d.id ? "bg-brand-50" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect?.(d.id)}
                className="flex-1 overflow-hidden text-left"
              >
                <p className="truncate font-medium text-slate-800">
                  {d.question || <span className="italic text-slate-400">untitled</span>}
                </p>
                <p className="truncate text-[10px] text-slate-500">
                  {new Date(d.updated_at).toLocaleString()}
                </p>
              </button>
              <button
                type="button"
                onClick={() => {
                  del.mutate(d.id, {
                    onSuccess: () => pushToast("Draft discarded", "info"),
                  });
                }}
                className="rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                aria-label="Discard draft"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
