/* Replaces every plain single-value <select> with an on-brand custom dropdown, since native
   <option> popups only allow background-color/color/padding to be styled - the popup frame itself
   is drawn by the OS/browser chrome and can't be themed. The underlying <select> stays in the DOM
   (hidden, not removed) so every existing onchange/.value/recalculate() call in app.js/ledger.js/
   invention.js/esi.js keeps working untouched - this is a UI skin over the real element, not a
   replacement for it. select[size] (the always-expanded blueprint location listbox) is left alone;
   it's already fully visible and doesn't need a "click to open" affordance. */
(function () {
  const CHEVRON_SVG = '<svg class="csel-trigger-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  let openPanel = null;
  let openTrigger = null;
  let openSelect = null;

  function closeOpenPanel() {
    if (openPanel) openPanel.remove();
    if (openTrigger) openTrigger.classList.remove('is-open');
    openPanel = null;
    openTrigger = null;
    openSelect = null;
  }

  function positionPanel(trigger, panel) {
    const r = trigger.getBoundingClientRect();
    panel.style.minWidth = r.width + 'px';
    document.body.appendChild(panel);
    const panelHeight = panel.offsetHeight;
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < panelHeight + 8 && r.top > spaceBelow) {
      panel.style.top = Math.max(8, r.top - panelHeight - 4) + 'px';
    } else {
      panel.style.top = (r.bottom + 4) + 'px';
    }
    let left = r.left;
    const maxLeft = window.innerWidth - panel.offsetWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    panel.style.left = left + 'px';
  }

  function buildPanel(select, trigger) {
    const panel = document.createElement('div');
    panel.className = 'csel-panel';
    Array.from(select.options).forEach((opt, idx) => {
      const item = document.createElement('div');
      item.className = 'csel-option' + (idx === select.selectedIndex ? ' is-selected' : '');
      item.textContent = opt.text;
      if (opt.disabled) item.setAttribute('aria-disabled', 'true');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (opt.disabled) return;
        if (select.selectedIndex !== idx) {
          select.selectedIndex = idx;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        updateTriggerLabel(select, trigger);
        closeOpenPanel();
      });
      panel.appendChild(item);
    });
    return panel;
  }

  function updateTriggerLabel(select, trigger) {
    const label = trigger.querySelector('.csel-trigger-label');
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.text : '';
  }

  function openPanelFor(select, trigger) {
    closeOpenPanel();
    const panel = buildPanel(select, trigger);
    positionPanel(trigger, panel);
    requestAnimationFrame(() => panel.classList.add('is-open'));
    trigger.classList.add('is-open');
    openPanel = panel;
    openTrigger = trigger;
    openSelect = select;
  }

  function initSelect(select) {
    if (select.dataset.cselInit || select.hasAttribute('size')) return;
    select.dataset.cselInit = '1';

    const originalClassName = select.className;
    select.classList.add('csel-native-hidden');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = (originalClassName + ' csel-trigger').trim();
    if (select.title) trigger.title = select.title;
    trigger.disabled = select.disabled;

    const label = document.createElement('span');
    label.className = 'csel-trigger-label';
    trigger.appendChild(label);
    trigger.insertAdjacentHTML('beforeend', CHEVRON_SVG);

    select.insertAdjacentElement('afterend', trigger);
    updateTriggerLabel(select, trigger);

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (trigger.disabled) return;
      if (openTrigger === trigger) { closeOpenPanel(); return; }
      openPanelFor(select, trigger);
    });

    select.addEventListener('change', () => {
      updateTriggerLabel(select, trigger);
      if (openSelect === select) closeOpenPanel();
    });

    new MutationObserver(() => {
      updateTriggerLabel(select, trigger);
      if (openSelect === select) openPanelFor(select, trigger);
    }).observe(select, { childList: true });

    new MutationObserver(() => { trigger.disabled = select.disabled; })
      .observe(select, { attributes: true, attributeFilter: ['disabled'] });
  }

  function scan() {
    document.querySelectorAll('select:not([size]):not([data-csel-init])').forEach(initSelect);
  }

  document.addEventListener('click', closeOpenPanel);
  window.addEventListener('scroll', closeOpenPanel, true);
  window.addEventListener('resize', closeOpenPanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpenPanel(); });

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
})();
