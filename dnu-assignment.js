// Only explicit assignment paths call this; loading rows or editing unrelated
// fields must never produce an acknowledgment.
export function isNewDnuAssignment(driver, previousDriverId) {
  return !!driver && String(driver.id) !== String(previousDriverId ?? '') &&
    String(driver.rating || '').toUpperCase().includes('DNU');
}

const pending = new Map();
let showing = false;
export function acknowledgeDnuAssignment(driver, previousDriverId = null) {
  if (!isNewDnuAssignment(driver, previousDriverId)) return;
  pending.set(String(driver.id), driver.name || 'This driver');
  if (showing) return;
  showing = true;
  // Finish the assignment event before moving focus into the dialog.
  queueMicrotask(showNextAcknowledgment);
}

function showNextAcknowledgment() {
  const next = pending.entries().next().value;
  if (!next) { showing = false; return; }
  const [id, name] = next;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'dnu-assignment-dialog';
  dialog.setAttribute('aria-labelledby', 'dnu-assignment-title');
  dialog.setAttribute('aria-describedby', 'dnu-assignment-message');
  const title = document.createElement('h3');
  title.id = 'dnu-assignment-title';
  title.textContent = 'DNU';
  const message = document.createElement('p');
  message.id = 'dnu-assignment-message';
  message.textContent = `${name} is marked Do Not Use. Acknowledge their DNU status before continuing with this assignment.`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = 'I acknowledge this driver is DNU';
  button.autofocus = true;
  // Escape and clicking outside cannot bypass acknowledgment.
  dialog.addEventListener('cancel', event => event.preventDefault());
  button.addEventListener('click', () => {
    pending.delete(id);
    dialog.close();
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    showNextAcknowledgment();
  });
  dialog.append(title, message, button);
  document.body.append(dialog);
  dialog.showModal();
  button.focus();
}
