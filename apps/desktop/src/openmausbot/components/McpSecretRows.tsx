// Adapted from OpenMausBot src/components/McpSecretRows.tsx at
// 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. Apache-2.0; see NOTICE.
// aut uses Radix controls, Chinese labels and saved references instead of upstream keep-value markers.
import { Button, IconButton, TextField } from "@radix-ui/themes";
import { Plus, X } from "lucide-react";
import { type ClipboardEvent, useId } from "react";
import { t } from "../../i18n.js";
import { type SecretRow, secretRow } from "./mcp-draft.js";

export function McpSecretRows({
  kind,
  rows,
  onChange,
  valuesOf,
}: {
  kind: "header" | "env";
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  valuesOf?: "gaps";
}) {
  const id = useId();
  const update = (id: number, patch: Partial<SecretRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const separator = kind === "header" ? ":" : "=";
  const pasteName = (row: SecretRow, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const at = text.indexOf(separator);
    if (at <= 0) return;
    event.preventDefault();
    update(row.id, { name: text.slice(0, at).trim(), value: text.slice(at + 1).trim() });
  };
  const valueInput = (row: SecretRow) => (
    <TextField.Root
      id={`${id}-${row.id}`}
      type="password"
      aria-label={row.name.trim() || t.mcpSecretValue}
      value={row.value}
      autoComplete="new-password"
      spellCheck={false}
      placeholder={row.savedValue ? t.mcpSecretSaved : t.mcpSecretValue}
      onChange={(event) => update(row.id, { value: event.target.value })}
    />
  );
  return (
    <div className="mcp-secret-rows">
      {rows
        .filter((row) => !valuesOf || row.gap)
        .map((row) => (
          <div key={row.id}>
            {valuesOf ? (
              <label className="mcp-field" htmlFor={`${id}-${row.id}`}>
                <span>{row.name}</span>
                {valueInput(row)}
              </label>
            ) : (
              <div className="mcp-secret-row">
                <TextField.Root
                  aria-label={kind === "header" ? t.mcpHeaderName : t.mcpEnvName}
                  value={row.name}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={kind === "header" ? "Authorization" : "API_KEY"}
                  onChange={(event) => update(row.id, { name: event.target.value })}
                  onPaste={(event) => pasteName(row, event)}
                />
                {valueInput(row)}
                <IconButton
                  type="button"
                  variant="ghost"
                  color="gray"
                  aria-label={`${t.mcpRemoveSecret} ${row.name || t.mcpSecretValue}`}
                  onClick={() =>
                    onChange(
                      rows.length > 1 ? rows.filter((other) => other.id !== row.id) : [secretRow()],
                    )
                  }
                >
                  <X size={14} />
                </IconButton>
              </div>
            )}
            {row.gap && !row.value.trim() && (
              <p className="mcp-field-hint">
                {t.mcpImportFillSecret}：{row.gap.names.join(", ")}
              </p>
            )}
          </div>
        ))}
      {!valuesOf && (
        <Button
          type="button"
          size="1"
          variant="ghost"
          onClick={() => onChange([...rows, secretRow()])}
        >
          <Plus size={13} />
          {t.mcpAddSecret}
        </Button>
      )}
    </div>
  );
}
