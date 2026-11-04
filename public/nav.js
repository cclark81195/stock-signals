// Shared site menu: a button in the top bar that opens a side panel with the three pages.
// Plain script, no dependencies. Works on every page that has a <header class="topbar">.
(function () {
  const PAGES = [
    { href: "/", file: "index.html", name: "Index Scanner", desc: "Buy, hold or sell signals for the Dow 30, S&P 500 and Nasdaq-100." },
    { href: "/daytrade.html", file: "daytrade.html", name: "Day Trade Lab", desc: "Quick in-and-out setups on 5-minute prices, tested with costs." },
    { href: "/swing.html", file: "swing.html", name: "Swing Lab", desc: "Multi-day strategies on up to 10 years of daily prices, versus the S&P 500." },
  ];
  const bar = document.querySelector("header.topbar");
  if (!bar) return;
  const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();

  // button + brand travel together on the left
  const brand = bar.querySelector(".brand");
  const left = document.createElement("div");
  left.className = "topbar-left";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "menu-btn";
  btn.setAttribute("aria-label", "Open menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "site-menu");
  btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
  left.appendChild(btn);
  if (brand) left.appendChild(brand);
  bar.insertBefore(left, bar.firstChild);

  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  const panel = document.createElement("aside");
  panel.id = "site-menu";
  panel.className = "menu-panel";
  panel.setAttribute("aria-label", "Site menu");
  panel.setAttribute("aria-hidden", "true");
  panel.inert = true;
  panel.innerHTML = '<div class="menu-head"><span>Menu</span><button type="button" class="menu-close" aria-label="Close menu">&times;</button></div><nav>' +
    PAGES.map((p) => {
      const cur = p.file === here;
      return '<a class="menu-link' + (cur ? " current" : "") + '" href="' + p.href + '"' + (cur ? ' aria-current="page"' : "") + '><strong>' + p.name + '</strong><span>' + p.desc + "</span></a>";
    }).join("") + "</nav>";
  document.body.append(overlay, panel);

  const close = panel.querySelector(".menu-close");
  function setOpen(open) {
    document.body.classList.toggle("menu-open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    panel.setAttribute("aria-hidden", String(!open));
    panel.inert = !open;
    if (open) (panel.querySelector(".menu-link.current") || panel.querySelector(".menu-link")).focus();
    else if (panel.contains(document.activeElement)) btn.focus();
  }
  btn.addEventListener("click", () => setOpen(!document.body.classList.contains("menu-open")));
  close.addEventListener("click", () => setOpen(false));
  overlay.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("menu-open")) return;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "Tab") { // keep focus inside the open panel
      const f = [...panel.querySelectorAll("a,button")];
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();
