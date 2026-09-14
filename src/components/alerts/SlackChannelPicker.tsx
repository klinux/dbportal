"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { appFetch } from "@/lib/config/base-path";
import { Hash, Lock, Search } from "lucide-react";

/**
 * A Slack channel picked by name (docs/CONTEXT.md §4.29): the list the bot can see, searched
 * as one types, the channel id handed back - the id is what the channel keeps, being stable
 * where the name is not. Where the server cannot list (no bot, a missing scope) the popover
 * says so and the id can still be typed in the field beside.
 */
export interface SlackChannelOption {
  id: string;
  name: string;
  private: boolean;
}

export function SlackChannelPicker({ onPick }: { onPick: (channel: SlackChannelOption) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [channels, setChannels] = useState<SlackChannelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    const timer = setTimeout(() => {
      setLoading(true);
      appFetch(`/api/channels/slack?q=${encodeURIComponent(query)}`)
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { channels?: SlackChannelOption[]; error?: string };
          if (ignore) return;
          if (!res.ok) {
            setError(body.error ?? `Slack channels could not be listed (${res.status})`);
            setChannels([]);
            return;
          }
          setError(null);
          setChannels(body.channels ?? []);
        })
        .catch(() => {
          if (!ignore) setError("Slack channels could not be listed");
        })
        .finally(() => {
          if (!ignore) setLoading(false);
        });
    }, 200);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5 border-hairline-strong shrink-0"
          data-testid="slack-picker-open"
        >
          <Search className="w-3 h-3" strokeWidth={1.75} />
          Find by name
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="slack-picker">
        <Command shouldFilter={false} loop className="bg-transparent">
          <CommandInput
            placeholder="Search Slack channels…"
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          <CommandList className="max-h-64">
            {error ? (
              <p className="px-3 py-2 text-xs text-danger" data-testid="slack-picker-error">
                {error}
              </p>
            ) : (
              <CommandEmpty className="py-3 text-center text-xs text-fg-muted">
                {loading ? "Looking…" : "No channel by that name that the bot can see."}
              </CommandEmpty>
            )}
            {!error && channels.length > 0 && (
              <CommandGroup heading="Channels">
                {channels.map((channel) => (
                  <CommandItem
                    key={channel.id}
                    value={channel.id}
                    onSelect={() => {
                      onPick(channel);
                      setOpen(false);
                    }}
                    className="text-xs cursor-pointer gap-2"
                    data-testid={`slack-option-${channel.id}`}
                  >
                    {channel.private ? (
                      <Lock className="w-3 h-3 text-fg-muted" strokeWidth={1.75} />
                    ) : (
                      <Hash className="w-3 h-3 text-fg-muted" strokeWidth={1.75} />
                    )}
                    <span className="flex-1">{channel.name}</span>
                    <span className="font-mono text-[10px] text-fg-muted">{channel.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
