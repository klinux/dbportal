"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKnownPrincipals } from "@/hooks/use-known-principals";
import { type PrincipalKind, principalKind } from "@/lib/principal-kind";
import { Plus, X } from "lucide-react";

/**
 * A list of principals picked rather than typed (docs/CONTEXT.md §4.37): the ones the
 * deployment already knows, of the kinds this list accepts, searchable; and a way to add
 * one nobody has named yet, in the kind's own shape. The chips are the value.
 */
export const KIND_LABEL: Record<PrincipalKind, string> = {
  wildcard: "everyone",
  role: "portal role",
  named: "named role",
  group: "group",
  user: "person",
};

/** What a typed entry is taken as, for the kinds allowed: `sre` becomes `group:sre` where groups are allowed. */
export function completeTyped(text: string, kinds: readonly PrincipalKind[]): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const kind = principalKind(raw);
  if (kind) return kinds.includes(kind) ? raw : null;
  if (/\s/.test(raw)) return null;
  if (kinds.includes("group")) return `group:${raw}`;
  if (kinds.includes("user")) return `user:${raw}`;
  if (kinds.includes("named")) return `role:${raw}`;
  return null;
}

export function PrincipalPicker({
  value,
  onChange,
  kinds,
  placeholder = "Add…",
  idPrefix,
  label,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  kinds: readonly PrincipalKind[];
  placeholder?: string;
  idPrefix: string;
  label: string;
}) {
  const known = useKnownPrincipals();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const candidates = known.filter((p) => kinds.includes(p.kind) && !value.includes(p.id));
  const typedId = completeTyped(typed, kinds);
  const canAddTyped = typedId !== null && !value.includes(typedId) && !candidates.some((c) => c.id === typedId);

  const add = (id: string) => {
    if (!value.includes(id)) onChange([...value, id]);
    setTyped("");
    setOpen(false);
  };

  return (
    <div className="space-y-1.5" data-testid={`${idPrefix}-picker`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((id) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-fill px-2 py-0.5 font-mono text-[11px] text-fg-secondary"
            data-testid={`${idPrefix}-chip-${id}`}
          >
            {id}
            <button
              type="button"
              className="text-fg-muted hover:text-fg"
              onClick={() => onChange(value.filter((v) => v !== id))}
              aria-label={`Remove ${id}`}
            >
              <X className="w-3 h-3" strokeWidth={1.75} />
            </button>
          </span>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5 border-hairline-strong"
              aria-label={label}
              data-testid={`${idPrefix}-add`}
            >
              <Plus className="w-3 h-3" strokeWidth={1.75} />
              {placeholder}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command loop className="bg-transparent">
              <CommandInput
                placeholder="Search or type a new one…"
                value={typed}
                onValueChange={setTyped}
                className="text-xs"
              />
              <CommandList className="max-h-64">
                <CommandEmpty className="py-3 text-center text-xs text-fg-muted">
                  {canAddTyped ? "Press Enter to add it." : "Nothing known; type one to add it."}
                </CommandEmpty>
                {canAddTyped && (
                  <CommandGroup heading="New">
                    <CommandItem
                      value={`add ${typedId}`}
                      onSelect={() => add(typedId!)}
                      className="text-xs cursor-pointer gap-2"
                      data-testid={`${idPrefix}-add-typed`}
                    >
                      <Plus className="w-3 h-3" strokeWidth={1.75} />
                      <span className="font-mono">{typedId}</span>
                    </CommandItem>
                  </CommandGroup>
                )}
                {(["wildcard", "role", "named", "group", "user"] as const)
                  .filter((kind) => kinds.includes(kind) && candidates.some((c) => c.kind === kind))
                  .map((kind) => (
                    <CommandGroup key={kind} heading={KIND_LABEL[kind]}>
                      {candidates
                        .filter((c) => c.kind === kind)
                        .map((c) => (
                          <CommandItem
                            key={c.id}
                            value={c.id}
                            onSelect={() => add(c.id)}
                            className="text-xs cursor-pointer gap-2"
                            data-testid={`${idPrefix}-option-${c.id}`}
                          >
                            <span className="font-mono flex-1">{c.id}</span>
                            <span className="text-[10px] text-fg-muted">{c.source}</span>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
