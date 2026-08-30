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
    const margin = 8;
    const r = trigger.getBoundingClientRect();
    panel.style.minWidth = r.width + 'px';

    // Give the panel as much of whichever side (above/below the trigger) has more room, up to a
    // generous cap - long lists (station/structure pickers) should show many rows at once instead
    // of forcing a tiny internal scroll, per explicit feedback that these need to be "much longer".
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const openBelow = spaceBelow >= 160 || spaceBelow >= spaceAbove;
    const available = Math.max(120, openBelow ? spaceBelow : spaceAbove);
    panel.style.maxHeight = Math.min(available, 640) + 'px';

    if (!panel.isConnected) document.body.appendChild(panel);
    const panelHeight = panel.offsetHeight;
    if (openBelow) {
      panel.style.top = (r.bottom + 4) + 'px';
    } else {
      panel.style.top = Math.max(margin, r.top - panelHeight - 4) + 'px';
    }
    let left = r.left;
    const maxLeft = window.innerWidth - panel.offsetWidth - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);
    panel.style.left = left + 'px';
  }

  // Options a caller (e.g. a "filter locations..." search box) has hidden via style.display='none'
  // are skipped here, so that existing filter-as-you-type code keeps working against the real
  // <select> without needing to know a custom panel sits in front of it.
  function buildOptionRows(panel, select, trigger) {
    panel.innerHTML = '';
    let visibleCount = 0;
    Array.from(select.options).forEach((opt, idx) => {
      if (opt.style.display === 'none') return;
      visibleCount++;
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
    if (visibleCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'csel-empty';
      empty.textContent = 'No matches';
      panel.appendChild(empty);
    }
  }

  function createPanel(select, trigger) {
    const panel = document.createElement('div');
    panel.className = 'csel-panel';
    // Without this, a click/mousedown that lands on the panel's own padding (or its scrollbar)
    // bubbles up to the document-level "click outside closes it" listener below and closes the
    // panel before the user can act on it.
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('click', (e) => e.stopPropagation());
    buildOptionRows(panel, select, trigger);
    return panel;
  }

  function updateTriggerLabel(select, trigger) {
    const label = trigger.querySelector('.csel-trigger-label');
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.text : '';
  }

  function openPanelFor(select, trigger) {
    if (openPanel && openSelect === select) {
      // Already open for this exact select (e.g. the user is typing in a location search box that
      // re-filters options live) - refresh content in place instead of remove/re-add, so the
      // entrance animation doesn't replay on every keystroke.
      buildOptionRows(openPanel, select, trigger);
      positionPanel(trigger, openPanel);
      return;
    }
    closeOpenPanel();
    const panel = createPanel(select, trigger);
    positionPanel(trigger, panel);
    requestAnimationFrame(() => panel.classList.add('is-open'));
    trigger.classList.add('is-open');
    openPanel = panel;
    openTrigger = trigger;
    openSelect = select;
  }

  // Public hook for code that filters a select's <option> list (by toggling style.display) from
  // outside this component - e.g. a "filter locations..." search box - so typing can pop the
  // dropdown open and keep it live-updated without that code knowing about .csel-panel internals.
  window.openCustomSelect = function (selectOrId) {
    const select = typeof selectOrId === 'string' ? document.getElementById(selectOrId) : selectOrId;
    if (!select) return;
    const trigger = select.nextElementSibling;
    if (!trigger || !trigger.classList || !trigger.classList.contains('csel-trigger')) return;
    openPanelFor(select, trigger);
  };

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
    // className copies Tailwind utility classes (font-size, font-weight, etc.), but NOT an inline
    // style="..." attribute - any select styled that way (e.g. style="color:var(--accent)") would
    // otherwise silently render with .csel-trigger's plain default color instead, since the real
    // <select> carrying that style gets hidden and only this trigger is ever visible.
    const inlineStyle = select.getAttribute('style');
    if (inlineStyle) trigger.setAttribute('style', inlineStyle);
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

    // subtree+attributeFilter:['style'] catches option.style.display toggles from external filter
    // code, not just options being added/removed - both should refresh the open panel live.
    new MutationObserver(() => {
      updateTriggerLabel(select, trigger);
      if (openSelect === select) openPanelFor(select, trigger);
    }).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

    new MutationObserver(() => { trigger.disabled = select.disabled; })
      .observe(select, { attributes: true, attributeFilter: ['disabled'] });

    // Code elsewhere sets select.value directly (e.g. loading a saved production preset) rather
    // than clicking through this fake dropdown - that's the whole point of leaving the real
    // <select> in the DOM per the file-header comment, and it DOES correctly update the real value
    // everything else (recalculate(), etc.) reads. But a plain property assignment fires neither a
    // 'change' event nor a DOM mutation the MutationObserver above can see, so without this the
    // trigger button's own visible label silently kept showing the old selection - correct data,
    // stale label. Overriding the instance's own value accessor (shadowing the prototype's) is the
    // one place that can't be bypassed by a future call site forgetting to dispatch 'change'.
    const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (nativeValueDescriptor && nativeValueDescriptor.set) {
      Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return nativeValueDescriptor.get.call(select); },
        set(v) {
          nativeValueDescriptor.set.call(select, v);
          updateTriggerLabel(select, trigger);
        }
      });
    }
  }

  function scan() {
    document.querySelectorAll('select:not([size]):not([data-csel-init])').forEach(initSelect);
  }

  document.addEventListener('click', closeOpenPanel);
  // Capture-phase so scrolling the page behind the dropdown closes it - but scrolling INSIDE the
  // panel's own option list (its overflow-y:auto) must not, or a long list becomes unscrollable.
  window.addEventListener('scroll', (e) => {
    if (openPanel && (e.target === openPanel || (e.target.nodeType === 1 && openPanel.contains(e.target)))) return;
    closeOpenPanel();
  }, true);
  window.addEventListener('resize', closeOpenPanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpenPanel(); });

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
})();
