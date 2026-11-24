import type { McpGrant, McpTool } from "@aut/protocol";

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
  const allowed = new Set(grant?.allowedTools ?? []);
  return (
    <section className="mcp-grant-row" aria-label={label}>
      <label>
        <input
          type="checkbox"
          disabled={disabled}
          checked={grant?.enabled ?? false}
          onChange={(event) =>
            onChange({ enabled: event.target.checked, allowedTools: [...allowed] })
          }
        />
        {label}
      </label>
      {tools.map((tool) => (
        <label key={tool.name} className="mcp-tool-check" title={tool.description}>
          <input
            type="checkbox"
            disabled={disabled || !grant?.enabled}
            checked={allowed.has(tool.name)}
            onChange={(event) => {
              const next = new Set(allowed);
              if (event.target.checked) next.add(tool.name);
              else next.delete(tool.name);
              onChange({ enabled: grant?.enabled ?? false, allowedTools: [...next] });
            }}
          />
          {tool.name}
        </label>
      ))}
    </section>
  );
}
