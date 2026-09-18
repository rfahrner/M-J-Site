// Driver-note presentation is independent of the table-header styling and
// of the time the cancellation was entered. Snapshot the shift details so
// these notes keep their meaning even after a load is archived.
export function cancellationNotePayload(row, driverId, reason, author) {
  return {
    driver_id: Number(driverId),
    note_text: String(reason || '').trim() || 'No reason provided',
    created_by: author,
    note_type: 'cancellation',
    source_shift_id: row.dbId || null,
    source_shift_date: row.shiftDate || null,
    source_shift_start: row.shiftStart || null,
    source_load_label: row.proNumber || null,
  };
}

export function shiftStartMinutes(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const clock = /^(\d{1,2}):?(\d{2})(?::\d{2})?$/.exec(text);
  if (clock) {
    const h = Number(clock[1]), m = Number(clock[2]);
    return h < 24 && m < 60 ? h * 60 + m : null;
  }
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (ampm) {
    const h = Number(ampm[1]), m = Number(ampm[2] || 0);
    return h >= 1 && h <= 12 && m < 60 ? (h % 12 + (/pm/i.test(ampm[3]) ? 12 : 0)) * 60 + m : null;
  }
  // Imported spreadsheet time cells can contain an Excel day fraction
  // (including a whole-day component). The board date stays authoritative.
  if (/^\d*\.\d+$/.test(text)) {
    const serial = Number(text);
    return Number.isFinite(serial) ? Math.round((serial % 1) * 1440) % 1440 : null;
  }
  return null;
}

function noteDetails(note) {
  // Read older clients' cancellation strings too. Never use created_at as
  // a substitute for the cancelled shift date/time.
  const legacy = /^Cancellation — (\d{4}-\d{2}-\d{2}) — (.*?) — ([\s\S]*)$/.exec(note.note_text || '');
  return {
    cancelled: note.note_type === 'cancellation' || !!legacy,
    date: note.source_shift_date || legacy?.[1] || '',
    start: shiftStartMinutes(note.source_shift_start),
    load: note.source_load_label || legacy?.[2] || '',
    text: legacy ? legacy[3] : (note.note_text || ''),
  };
}

function shiftDate(dateKey, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (date.getFullYear() !== Number(m[1]) || date.getMonth() !== Number(m[2]) - 1 || date.getDate() !== Number(m[3])) return null;
  date.setMinutes(minutes ?? 0);
  return date;
}

function noteSortTime(note) {
  const detail = noteDetails(note);
  if (detail.cancelled) return shiftDate(detail.date, detail.start)?.getTime() ?? 0;
  return Date.parse(note.created_at) || 0;
}

export function sortDriverNotes(notes) {
  return [...notes].sort((a, b) => noteSortTime(b) - noteSortTime(a)
    || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
    || Number(b.id || 0) - Number(a.id || 0));
}

export function driverNoteRowHtml(note, escapeHtml) {
  const detail = noteDetails(note);
  const options = { year: 'numeric', month: 'numeric', day: 'numeric' };
  let when;
  if (detail.cancelled) {
    const date = shiftDate(detail.date, 0);
    const clock = detail.start == null ? 'time not recorded'
      : `${String(Math.floor(detail.start / 60)).padStart(2, '0')}:${String(detail.start % 60).padStart(2, '0')}`;
    when = `${date ? date.toLocaleDateString('en-US', options) : 'Shift date not recorded'} · ${clock}`;
  } else {
    const date = new Date(note.created_at);
    when = Number.isNaN(date.getTime()) ? 'Date not recorded'
      : date.toLocaleString('en-US', { ...options, hour: 'numeric', minute: '2-digit' });
  }
  const text = detail.cancelled
    ? `Cancellation${detail.load ? ` — Load ${detail.load}` : ''} — ${detail.text}`
    : detail.text;
  return `<div class="driver-note-row">
    <div class="driver-note-meta"><span>${escapeHtml(when)}</span><span>By ${escapeHtml(note.created_by || 'User not recorded')}</span></div>
    <div class="driver-note-text">${escapeHtml(text)}</div>
  </div>`;
}
