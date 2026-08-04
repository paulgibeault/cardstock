// The in-page confirmation, shared by the lobby and the table.
//
// NOT window.confirm(): a framed game runs in an opaque-origin iframe, where
// the native dialog is unreliable at best and blocked at worst (design doc
// §17.1). It lived in src/ui/lobby.js until the table needed one too — for
// forfeiting — and a second copy of a modal is how two dialogs end up
// disagreeing about which button is the dangerous one.

const el = {
  modal: document.getElementById('confirm-modal'),
  message: document.getElementById('confirm-message'),
  ok: document.getElementById('confirm-ok'),
  cancel: document.getElementById('confirm-cancel'),
};

/**
 * Ask, and resolve with the answer.
 *
 * Both labels are parameters because the honest wording differs per call, and
 * a generic "OK / Cancel" makes the destructive option the one that reads as
 * neutral. The default pair is the lobby's original.
 */
export function confirmAction(message, { okLabel = 'Start over', cancelLabel = 'Keep playing' } = {}) {
  el.message.textContent = message;
  el.ok.textContent = okLabel;
  el.cancel.textContent = cancelLabel;
  el.modal.hidden = false;
  return new Promise((resolve) => {
    const close = (answer) => {
      el.modal.hidden = true;
      el.ok.onclick = null;
      el.cancel.onclick = null;
      resolve(answer);
    };
    el.ok.onclick = () => close(true);
    el.cancel.onclick = () => close(false);
  });
}

/** Close an open dialog without answering it — a screen change under it. */
export function closeConfirm() {
  el.modal.hidden = true;
}
