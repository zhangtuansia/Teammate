/**
 * Message timestamps do not all arrive in one shape. The local service writes
 * ISO, but older rows carry the space-separated SQL form, and the two engines
 * disagree about it: Chrome parses `2026-08-21 09:56:00` as local time while
 * Safari — which is what the desktop shell runs — rejects it outright. Parsing
 * through here instead of `new Date` makes both engines agree, and gives
 * callers an explicit null for a value that is genuinely unusable.
 */
export function parseMessageTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  // The bare SQL form has to be recognised before `new Date` sees it: V8 does
  // parse it, but as local time, so leaving it to the engine would still put
  // Chrome and Safari on different instants. The rest of the data is UTC and
  // this is read the same way. The pattern requires the space separator and no
  // zone, so a real ISO string never reaches it.
  const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  const parsed = new Date(sql ? `${sql[1]}T${sql[2]}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Clock time for a message, or an empty string when it cannot be dated. */
export function formatMessageClock(value: string | null | undefined) {
  const date = parseMessageTime(value);
  if (!date) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
