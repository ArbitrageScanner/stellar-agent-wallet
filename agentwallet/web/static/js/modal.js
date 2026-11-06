// One app-wide modal built on <dialog>. Opening a modal while one is open
// replaces its content (a form can turn into the op flow in place).

import { h, icon, ICONS, normAmount } from './util.js';

let dlg, titleEl, bodyEl, closeBtn;
let current = null; // {onClose, dismissible}

function ensure() {
  if (dlg) return;
  dlg = document.getElementById('modal');
  titleEl = document.getElementById('modal-title');
  bodyEl = document.getElementById('modal-body');
  closeBtn = document.getElementById('modal-close');
  closeBtn.replaceChildren(icon(ICONS.close));
  closeBtn.addEventListener('click', () => closeModal());
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!current || current.dismissible !== false) closeModal();
  });
  // Click on the backdrop (outside the card) closes the modal.
  dlg.addEventListener('mousedown', (e) => {
    if (e.target === dlg && (!current || current.dismissible !== false)) closeModal();
  });
}

/** Opens (or reuses) the modal. Returns a handle {body, setTitle, close, isOpen}. */
export function openModal({ title = '', content = null, onClose = null, dismissible = true, size = '' } = {}) {
  ensure();
  const prev = current;
  current = { onClose, dismissible };
  if (prev && prev.onClose) { try { prev.onClose('replaced'); } catch { /* ignore */ } }
  titleEl.textContent = title;
  bodyEl.replaceChildren(...[].concat(content || []));
  dlg.dataset.size = size;
  if (!dlg.open) {
    dlg.showModal();
    document.body.classList.add('modal-open');
  }
  const mine = current;
  return {
    body: bodyEl,
    setTitle: (t) => { if (current === mine) titleEl.textContent = t; },
    setDismissible: (d) => { if (current === mine) mine.dismissible = d; },
    close: () => { if (current === mine) closeModal(); },
    isOpen: () => current === mine && dlg.open,
  };
}

export function closeModal() {
  ensure();
  const c = current;
  current = null;
  if (dlg.open) dlg.close();
  document.body.classList.remove('modal-open');
  bodyEl.replaceChildren();
  if (c && c.onClose) { try { c.onClose('closed'); } catch { /* ignore */ } }
}

export const isModalOpen = () => !!(dlg && dlg.open);

/** Small form modal for one amount. Resolves to the normalized amount, or null if closed. */
export function promptAmount({ title, label, help = null, value = '', submitLabel = 'Continue', max = null, extra = null, testid = 'amount-form' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', {
      class: 'input', type: 'text', inputmode: 'decimal', name: 'amount', value, required: true,
      autocomplete: 'off', spellcheck: 'false', 'aria-label': label,
    });
    const err = h('div', { class: 'field-err', role: 'alert' });
    const form = h('form', { class: 'modal-form', 'data-testid': testid },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, label),
        h('div', { class: 'input-affix' }, input, h('span', {}, 'USDC'))),
      max !== null ? h('div', { class: 'field-hint' }, 'Available: ',
        h('button', { class: 'linkish', type: 'button', onClick: () => { input.value = String(max); input.focus(); } }, `${max} USDC`)) : null,
      help ? h('p', { class: 'muted small' }, help) : null,
      extra,
      err,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => closeModal() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = normAmount(input.value);
      if (!v) { err.textContent = 'Enter a positive amount, e.g. 5 or 2.5 (up to 7 decimals).'; input.focus(); return; }
      if (max !== null && Number(v) > Number(max)) { err.textContent = `That is more than the available ${max} USDC.`; input.focus(); return; }
      done = true;
      resolve(v);
    });
    openModal({ title, content: form, onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
