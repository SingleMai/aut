// Adapted from OpenMausBot src/components/bot-settings/AccessSection.tsx
// (McpServersCard and ConnectorToolsGrants), commit
// 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. Apache-2.0; see NOTICE.
// aut keeps explicit tool names, defaults off and acknowledges each grant through its existing API.
import type { McpGrant, McpTool } from "@aut/protocol";
import { Button, Checkbox, Switch, TextField } from "@radix-ui/themes";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useId, useState } from "react";
import { t } from "./i18n.js";

export type McpGrantDraft = Pick<McpGrant, "enabled" | "allowedTools">;
export function McpGrantFields({
  label,
  tools,
  grant,
  disabled,
  onChange,
}: {
  label: string;
  tools: readonly McpTool[];
  grant: McpGrantDraft | undefined;
  disabled: boolean;
  onChange: (value: McpGrantDraft) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const allowed = new Set(grant?.allowedTools ?? []);
  const query = search.trim().toLowerCase();
  const matches = tools.filter((tool) =>
    `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(query),
  );
  return (
    <section className="mcp-grant-row" aria-label={label}>
      <div className="mcp-grant-heading">
        <button
          type="button"
          className="mcp-grant-expand"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setSearch("");
          }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <strong>{label}</strong>
          <span>
            {grant?.enabled
              ? `${allowed.size} / ${tools.length} ${t.mcpToolCount}`
              : t.mcpNotGranted}
          </span>
        </button>
        <Switch
          size="1"
          aria-label={`${t.mcpAllow} ${label}`}
          disabled={disabled}
          checked={grant?.enabled ?? false}
          onCheckedChange={(enabled) => {
            onChange({ enabled, allowedTools: [...allowed] });
            if (enabled) setOpen(true);
          }}
        />
      </div>
      {open && (
        <div className="mcp-grant-body">
          {!tools.length ? (
            <p className="muted">{t.botMcpNoTools}</p>
          ) : (
            <>
              <div className="mcp-tool-controls">
                <TextField.Root
                  aria-label={`${t.mcpSearchTools} · ${label}`}
                  placeholder={t.mcpSearchTools}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                >
                  <TextField.Slot>
                    <Search size={14} />
                  </TextField.Slot>
                </TextField.Root>
                <Button
                  type="button"
                  size="1"
                  variant="ghost"
                  disabled={disabled || !grant?.enabled}
                  onClick={() =>
                    onChange({ enabled: true, allowedTools: tools.map((tool) => tool.name) })
                  }
                >
                  {t.mcpSelectCurrent}
                </Button>
                <Button
                  type="button"
                  size="1"
                  variant="ghost"
                  color="gray"
                  disabled={disabled || !grant?.enabled || !allowed.size}
                  onClick={() => onChange({ enabled: true, allowedTools: [] })}
                >
                  {t.mcpClearTools}
                </Button>
              </div>
              <div className="mcp-tool-list">
                {matches.map((tool) => (
                  <label key={tool.name} className="mcp-tool-check" htmlFor={`${id}-${tool.name}`}>
                    <Checkbox
                      id={`${id}-${tool.name}`}
                      aria-label={tool.name}
                      disabled={disabled || !grant?.enabled}
                      checked={allowed.has(tool.name)}
                      onCheckedChange={(checked) => {
                        const next = new Set(allowed);
                        if (checked === true) next.add(tool.name);
                        else next.delete(tool.name);
                        onChange({ enabled: grant?.enabled ?? false, allowedTools: [...next] });
                      }}
                    />
                    <span>
                      <code>{tool.name}</code>
                      {(tool.description || tool.title) && (
                        <small>{tool.description || tool.title}</small>
                      )}
                    </span>
                  </label>
                ))}
                {!matches.length && <p className="muted">{t.mcpNoMatches}</p>}
              </div>
              {grant?.enabled && !allowed.size && (
                <p className="mcp-field-hint">{t.mcpSelectToolsHint}</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
