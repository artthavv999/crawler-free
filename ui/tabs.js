// WAI-ARIA tabs (automatic activation) and accordion with full keyboard support.

// Tabs: ←/→ move and select (wrapping), Home/End jump; one tab in the tab order; panels toggle `hidden`.
export function tabs(list, onSelect) {
  const all = () => [...list.querySelectorAll('[role="tab"]')];
  const ink = () => {
    let i = list.querySelector(".tab-ink");
    if (!i) {
      i = document.createElement("span");
      i.className = "tab-ink";
      i.setAttribute("aria-hidden", "true");
      list.append(i);
    }
    return i;
  };
  const place = () => {
    const t = all().find((x) => x.getAttribute("aria-selected") === "true");
    if (!t) return;
    const i = ink();
    i.style.setProperty("--x", `${t.offsetLeft}px`);
    i.style.setProperty("--w", String(t.offsetWidth)); // scaleX of a 1px bar: stays on the compositor
  };
  function select(tab, focus) {
    if (!tab) return;
    for (const t of all()) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
    place();
    onSelect?.(tab);
  }
  list.addEventListener("click", (e) => select(e.target.closest('[role="tab"]'), false));
  list.addEventListener("keydown", (e) => {
    const ts = all(), i = ts.indexOf(document.activeElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ts.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    select(ts[(next + ts.length) % ts.length], true);
  });
  new ResizeObserver(place).observe(list);
  place();
  return { select: (tab) => select(tab, false), place };
}

// Accordion: each header is a button with aria-expanded; ↑/↓ move between headers, Home/End jump.
export function accordion(root) {
  const buttons = [...root.querySelectorAll(".acc-btn")];
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      b.closest(".acc-item").classList.toggle("open", open);
    });
  }
  root.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length].focus();
  });
}
