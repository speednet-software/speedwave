/**
 * Pretty-prints a byte count as a short B/KB/MB/GB string (binary units,
 * 1024-based). Shared by the attachment strip and the transcription section.
 * @param bytes - size in bytes.
 */
export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}
