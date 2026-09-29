/**
 * Heading paths begin with the document's own H1 ("Handbook › Refunds"). Next to the document title that repeats itself,
 * so show only the part below it ("Refunds"). Falls back to the full path when nothing distinct remains.
 */
export function sectionLabel(documentTitle: string, headingPath: string): string {
  if (!headingPath) return "";
  const parts = headingPath.split(" › ");
  const norm = (s: string) => s.trim().toLowerCase();
  const rest = norm(parts[0] ?? "") === norm(documentTitle) ? parts.slice(1) : parts;
  return rest.join(" › ");
}
