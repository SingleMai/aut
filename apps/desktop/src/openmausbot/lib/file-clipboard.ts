// Copied from OpenMausBot src/lib/composer-attachments.ts, commit 4250c53a3acb0218870a4041101cb08b116160ce.
// Apache-2.0; see NOTICE. aut uses these clipboard helpers with its snapshot API.
export function isImageFile(file: { type: string; size?: number }): boolean {
  return (
    file.type.startsWith("image/") &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      (file.type.split(";")[0] ?? "").trim().toLowerCase(),
    )
  );
}

/** Items first: Chromium on macOS exposes screenshots via items while clipboardData.files may stay empty. */
export function clipboardImageFiles(
  clipboardData:
    | {
        files?: Iterable<File> | null;
        items?: Iterable<{ kind: string; type: string; getAsFile(): File | null }> | null;
      }
    | null
    | undefined,
): File[] {
  if (!clipboardData) return [];
  if (clipboardData.items) {
    const fromItems: File[] = [];
    for (const item of clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file && isImageFile(file)) {
          fromItems.push(file);
        }
      }
    }
    if (fromItems.length > 0) return fromItems;
  }
  if (clipboardData.files) {
    return Array.from(clipboardData.files).filter(isImageFile);
  }
  return [];
}

/** A file copied in Finder or Explorer reaches a paste in clipboardData.files (Chromium), with only its name as text.
 * Anything there but pictures is attached the way a picked file is; pictures alone keep the image paste. */
export function clipboardFilesToAttach<T extends { type: string }>(
  clipboardData: { files?: Iterable<T> | null } | null | undefined,
): T[] {
  const files = Array.from(clipboardData?.files ?? []);
  return files.some((file) => !isImageFile(file)) ? files : [];
}
