/* Keep the Archive dashboard aligned with the high-volume backup policy. */
(function installArchiveCapacityLabel() {
  function apply() {
    const panel = document.getElementById('image-backup-panel');
    if (!panel) return;

    const meta = [...panel.querySelectorAll('.image-backup-meta > span')];
    const schedule = meta.find((el) => /schedule:/i.test(el.textContent || ''));
    const scheduleHtml = '<strong>Schedule:</strong> Every 15 minutes';
    // Replacing identical HTML still emits a childList mutation. Since this
    // observer watches our writes too, only change the label when needed.
    if (schedule && schedule.innerHTML !== scheduleHtml) schedule.innerHTML = scheduleHtml;

    let note = document.getElementById('image-backup-capacity-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'image-backup-capacity-note';
      note.className = 'image-backup-note';
      note.textContent = 'High-volume protection: normal retention is 21 days. If Supabase image storage reaches 80% of the 1 GB limit, the oldest images over 7 days old become eligible to move early so new uploads are not blocked.';
      panel.appendChild(note);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();

  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 15000);
})();
