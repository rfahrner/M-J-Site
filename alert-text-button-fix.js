/*
 * Reliable Alerts -> Text bridge.
 *
 * The alert widget is rendered by alerts.js while the send-text modal lives in
 * loadboard.js. Both modules already depend on each other during startup, so a
 * second static import between them is intentionally avoided here. Instead we
 * intercept only an actual alert Text click and dynamically load the two
 * existing APIs after the application has finished initializing.
 *
 * This also gives the Text button one owner: the capture handler stops the old
 * delegated click from firing a second time.
 */
(() => {
  let opening = false;

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('[data-alert-action-key]');
    if (!button || !button.closest('#alert-widget')) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (opening) return;

    const key = String(button.dataset.alertActionKey || '');
    if (!key) return;

    opening = true;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '...';

    try {
      const [alertsModule, loadboardModule] = await Promise.all([
        import('./alerts.js'),
        import('./loadboard.js'),
      ]);

      // Re-scan so the button is resolved against the same live alert rules
      // that created it, rather than trying to reconstruct recipients/message
      // from DOM text.
      const alerts = await alertsModule.scanForBoardAlerts();
      const alert = (alerts || []).find((item) => item.key === key);

      if (!alert) {
        console.warn('Alert Text click could not resolve alert key:', key);
        return;
      }
      if (!Array.isArray(alert.recipients) || !alert.recipients.length) {
        console.warn('Alert Text click has no recipient:', key);
        return;
      }

      loadboardModule.openSendTextModal(
        alert.recipients,
        alert.actionMessage || '',
        alert.markShiftIdsOnSent || null,
        // The alert has been acted on the moment the message leaves the modal --
        // whether the gateway took it or the dispatcher fell back to an Outlook
        // draft. Repeating rules still re-fire on their own schedule under a new
        // key, so this clears the one that was just handled, nothing more.
        { onSent: () => alertsModule.dismissAlert(key) },
      );
    } catch (error) {
      console.error('Alert Text button failed:', error);
    } finally {
      opening = false;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = originalText || 'Text';
      }
    }
  }, true);
})();
