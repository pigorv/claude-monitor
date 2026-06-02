/** Maps a tool name to its design-system tag class (one of five).
 *  Order: modify/agentic keywords win over the bare "write" so TodoWrite→purple. */
export function toolTagClass(name: string): string {
  const n = (name || '').toLowerCase();
  if (n.includes('bash')) return 'tool-bash';
  if (/edit|multiedit|notebook|task|agent|todo|ask/.test(n)) return 'tool-edit';
  if (n.includes('write')) return 'tool-write';
  if (/read|grep|glob|web|search|fetch/.test(n)) return 'tool-read';
  return 'tool-default';
}
