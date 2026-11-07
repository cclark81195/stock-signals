// Swing Lab / Day Trade Lab - shared visual effects: on/off switches (remembered) and the rolling-digit stat tiles.
const DEFS = {
  depth: ["Depth + trails", true],
  sectors: ["Sector clusters", true],
  hud: ["HUD framing", false],
  odo: ["Odometer stats", true],
  ribbon: ["Equity ribbon", true],
};
export const fx = {};
for (const k of Object.keys(DEFS)) fx[k] = DEFS[k][1];
try { const s = JSON.parse(localStorage.getItem("swing-fx") || "null"); if (s) for (const k of Object.keys(DEFS)) if (typeof s[k] === "boolean") fx[k] = s[k]; } catch { /* ignore */ }
const subs = new Set();
export const onFx = (fn) => { subs.add(fn); };
export function setFx(k, on) {
  if (!(k in DEFS) || fx[k] === on) return;
  fx[k] = on;
  try { localStorage.setItem("swing-fx", JSON.stringify(fx)); } catch { /* ignore */ }
  for (const fn of subs) fn(k, on);
}

/** The switches. keys: which effects this page has. */
export function buildFxPanel(host, keys) {
  host.innerHTML = '<div class="fx-head"><span class="scan-lbl">Effects</span><button type="button" class="link-btn" data-all="1">All on</button><button type="button" class="link-btn" data-all="0">All off</button></div><div class="fx-grid"></div>';
  const grid = host.querySelector(".fx-grid");
  for (const k of keys) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "fx-sw"; b.dataset.fx = k; b.setAttribute("role", "switch");
    b.innerHTML = `<i class="trk"></i><span>${DEFS[k][0]}</span>`;
    b.addEventListener("click", () => setFx(k, !fx[k]));
    grid.appendChild(b);
  }
  const sync = () => { for (const b of grid.children) b.setAttribute("aria-checked", String(fx[b.dataset.fx])); };
  host.addEventListener("click", (e) => { const a = e.target.closest("[data-all]"); if (!a) return; for (const k of keys) setFx(k, a.dataset.all === "1" ? k !== "hud" : false); });
  onFx(sync); sync();
}

// ---- rolling digits: each digit of a tile's number is a reel that slides to its new value
const last = new Map();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export function rollNumbers(container) {
  if (!container) return;
  const on = fx.odo && !reduced();
  for (const tile of container.querySelectorAll(".dt-tile")) {
    const k = tile.querySelector(".k"), v = tile.querySelector(".v");
    if (!k || !v || v.children.length) continue;
    const key = container.id + "|" + k.textContent, text = v.textContent, prev = last.get(key);
    last.set(key, text);
    if (!on || !/[0-9]/.test(text)) continue;
    const sig = (t) => t.replace(/[0-9]/g, "#");
    const from = prev && sig(prev) === sig(text) ? prev : null;     // different shape (digits added or removed): no roll, just show it
    v.setAttribute("role", "img"); v.setAttribute("aria-label", text);
    v.textContent = "";
    const reels = [];
    [...text].forEach((ch, i) => {
      if (ch >= "0" && ch <= "9") {
        const od = document.createElement("span"); od.className = "od"; od.setAttribute("aria-hidden", "true");
        const rl = document.createElement("span"); rl.className = "rl";
        rl.innerHTML = "<i>0</i><i>1</i><i>2</i><i>3</i><i>4</i><i>5</i><i>6</i><i>7</i><i>8</i><i>9</i>";
        rl.style.transition = "none"; rl.style.transform = `translateY(${-(from ? +from[i] : +ch) * 1.1}em)`;
        od.appendChild(rl); v.appendChild(od); reels.push([rl, +ch]);
      } else { const s = document.createElement("span"); s.setAttribute("aria-hidden", "true"); s.textContent = ch; v.appendChild(s); }
    });
    if (from && from !== text) { void v.offsetWidth; for (const [rl, d] of reels) { rl.style.transition = ""; rl.style.transform = `translateY(${-d * 1.1}em)`; } }
  }
}
