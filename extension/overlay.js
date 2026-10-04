// overlay.js - Content script: visual feedback while an MCP client drives this tab.
//
// Renders the control frame, Kap (the mascot) with a speech bubble naming the
// current action, and the virtual cursor. Everything lives in a closed shadow
// root on a host attached to <html> (not <body>), so `dom` output, selectors and
// elementsFromPoint (pointer-events: none) never see it. Loaded before
// page-helpers.js, which drives it through the global `wispOverlay`.

const wispOverlay = (() => {
  const IDLE_MS = 2500;
  const MOOD_MS = 1400;

  let host = null;
  let root = null;
  let active = false;
  let mascotEnabled = true;
  let cursorPos = null; // last virtual cursor position (viewport coords)
  let idleTimer = null;
  let moodTimer = null;
  let blinkTimer = null;
  let wanderTimer = null;
  let logEnabled = true;
  let ghost = null; // where the wisp is now, in viewport coords

  const GHOST_W = 58;
  const GHOST_H = 66;
  const MARGIN = 16;

  const STYLE = `
    :host { all: initial; }
    .layer {
      position: fixed; inset: 0; pointer-events: none;
      z-index: 2147483647; opacity: 0; transition: opacity .3s ease;
      font: 500 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --amber: #f59e0b;
      --amber-soft: rgba(245, 158, 11, .35);
    }
    .layer.active { opacity: 1; }
    .layer.capturing { display: none; }

    /* --- frame ------------------------------------------------------- */
    .frame {
      position: absolute; inset: 0;
      box-shadow: inset 0 0 0 1.5px rgba(245, 158, 11, .85),
                  inset 0 0 22px 3px var(--amber-soft);
      animation: breathe 2.6s ease-in-out infinite;
    }
    .layer.busy .frame { animation-duration: 1.1s; }
    @keyframes breathe { 0%, 100% { opacity: .5 } 50% { opacity: 1 } }

    /* --- mascot ------------------------------------------------------ */
    /* The wisp flies: .mascot-wrap is positioned at 0,0 and moved by transform,
       so one transition drives the whole trip. */
    .mascot-wrap {
      position: absolute; top: 0; left: 0;
      display: flex; align-items: flex-end; gap: 8px;
      transform: translate(-999px, -999px);
      transition: transform .9s cubic-bezier(.33, .9, .3, 1), opacity .3s ease;
      will-change: transform;
    }
    .mascot-wrap.flip { flex-direction: row-reverse; }
    .mascot-wrap.flip .bubble { border-radius: 13px 13px 13px 3px; transform-origin: bottom left; }
    .layer.idle .mascot-wrap { opacity: .8; }
    .mascot-wrap[hidden] { display: none; }

    .bubble {
      max-width: 180px; padding: 7px 11px;
      border-radius: 13px 13px 3px 13px;
      background: rgba(29, 25, 23, .93);
      color: #f5efe6; font-size: 11.5px; letter-spacing: .01em;
      box-shadow: 0 6px 20px rgba(69, 39, 3, .5), 0 0 0 1px rgba(252, 211, 77, .35);
      opacity: 0; transform: translateY(4px) scale(.96);
      transform-origin: bottom right;
      transition: opacity .22s ease, transform .22s cubic-bezier(.2, .9, .3, 1.2);
    }
    .bubble.show { opacity: 1; transform: none; }
    .bubble b { color: #fcd34d; font-weight: 600; }

    .mascot { width: 58px; height: 66px; display: block; animation: float 3.4s ease-in-out infinite; }
    .layer.busy .mascot { animation-duration: 1.5s; }
    @keyframes float {
      0%, 100% { transform: translateY(0) }
      50% { transform: translateY(-5px) }
    }

    /* sparkles twinkle out of phase */
    .spk { transform-origin: center; transform-box: fill-box; animation: twinkle 2.6s ease-in-out infinite }
    .spk.b { animation-duration: 3.3s; animation-delay: -1.1s }
    .spk.c { animation-duration: 2.1s; animation-delay: -.6s }
    .layer.busy .spk { animation-duration: 1.1s }
    @keyframes twinkle {
      0%, 100% { opacity: .2; transform: scale(.6) rotate(0deg) }
      50% { opacity: 1; transform: scale(1.15) rotate(25deg) }
    }

    /* the hem ripples like cloth */
    .hull { animation: hem 3s ease-in-out infinite }
    .layer.busy .hull { animation-duration: 1.4s }
    @keyframes hem {
      0%, 100% { d: path("M29 5c11.6 0 20 8.6 20 20.5V46q-6.7 8-13.3 0q-6.7 8-13.3 0q-6.7 8-13.4 0V25.5C9 13.6 17.4 5 29 5Z") }
      50% { d: path("M29 5c11.6 0 20 8.6 20 20.5V50q-6.7 5-13.3 0q-6.7 8-13.3 0q-6.7 5-13.4 0V25.5C9 13.6 17.4 5 29 5Z") }
    }

    /* the shadow breathes with the float */
    .shadow { transform-origin: center; transform-box: fill-box; animation: shade 3.4s ease-in-out infinite }
    .layer.busy .shadow { animation-duration: 1.5s }
    @keyframes shade {
      0%, 100% { opacity: .9; transform: scaleX(1) }
      50% { opacity: .5; transform: scaleX(.82) }
    }

    .eyes { transition: transform .25s cubic-bezier(.2, .9, .3, 1) }
    .lid { transform: scaleY(0); transform-origin: center; transform-box: fill-box; }
    .blinking .lid { animation: blink .18s ease-in-out; }
    @keyframes blink { 0%, 100% { transform: scaleY(0) } 50% { transform: scaleY(1) } }

    /* happy swaps the eyes for two arcs; oops squints them */
    .eyes-open, .eyes-happy { transition: opacity .18s ease, transform .18s ease }
    .eyes-happy { opacity: 0 }
    .mood-happy .eyes-happy { opacity: 1 }
    .mood-happy .eyes-open { opacity: 0 }
    .mood-oops .eyes-open { transform: translateY(1.5px) scaleY(.8); transform-origin: center; transform-box: fill-box }

    .mouth { transition: d .2s ease, opacity .2s ease }
    .mouth-idle, .mouth-busy, .mouth-happy, .mouth-oops { opacity: 0 }
    .mood-idle .mouth-idle,
    .mood-busy .mouth-busy,
    .mood-happy .mouth-happy,
    .mood-oops .mouth-oops { opacity: 1 }

    /* --- cursor ------------------------------------------------------ */
    .cursor {
      position: absolute; top: 0; left: 0; width: 20px; height: 20px;
      will-change: transform; transition: opacity .3s ease;
      filter: drop-shadow(0 0 4px rgba(245, 158, 11, .9)) drop-shadow(0 0 10px var(--amber-soft));
    }
    .cursor[hidden] { display: none }
    .layer.idle .cursor { opacity: .55 }

    .ripple {
      position: absolute; top: 0; left: 0; width: 36px; height: 36px;
      margin: -18px 0 0 -18px; border-radius: 50%;
      border: 2px solid rgba(252, 211, 77, .95);
      background: rgba(245, 158, 11, .22);
      animation: ripple .5s ease-out forwards;
    }
    @keyframes ripple {
      from { transform: var(--at) scale(.3); opacity: 1 }
      to { transform: var(--at) scale(1.6); opacity: 0 }
    }

    /* --- highlight boxes --------------------------------------------- */
    .hl {
      position: absolute; border: 2px solid var(--amber);
      border-radius: 4px; background: rgba(245, 158, 11, .12);
      box-shadow: 0 0 0 1px rgba(255, 251, 235, .35), 0 0 18px rgba(245, 158, 11, .45);
      animation: hlIn .22s ease-out;
    }
    .hl-tag {
      position: absolute; transform: translateY(-100%);
      padding: 3px 7px; border-radius: 6px 6px 6px 0;
      background: var(--amber); color: #231709;
      font-size: 10.5px; font-weight: 700; white-space: nowrap;
    }
    @keyframes hlIn {
      from { opacity: 0; transform: scale(1.06) }
      to { opacity: 1; transform: none }
    }

    /* --- activity log ------------------------------------------------ */
    .log {
      position: absolute; left: 16px; bottom: 16px;
      width: 236px; max-height: 190px; overflow: hidden;
      display: flex; flex-direction: column-reverse; gap: 3px;
      opacity: 0; transition: opacity .3s ease;
    }
    .log.show { opacity: 1; }
    .log[hidden] { display: none; }
    .log-row {
      display: flex; gap: 7px; align-items: baseline;
      padding: 4px 9px; border-radius: 8px;
      background: rgba(29, 25, 23, .9);
      box-shadow: 0 2px 10px rgba(12, 8, 4, .4), 0 0 0 1px rgba(252, 211, 77, .18);
      color: #f5efe6; font-size: 10.5px; white-space: nowrap;
      animation: logIn .25s ease-out;
    }
    .log-row time { color: #a79e92; font-variant-numeric: tabular-nums; font-size: 9.5px; }
    .log-row .what { color: #fcd34d; font-weight: 600; }
    .log-row .detail { color: #d6cec2; overflow: hidden; text-overflow: ellipsis; }
    .log-row.err .what { color: #fb7185; }
    .log-row.fade { opacity: .45; }
    .log-row.fade-more { opacity: .2; }
    @keyframes logIn {
      from { opacity: 0; transform: translateY(6px) }
      to { opacity: 1; transform: none }
    }

    @media (prefers-reduced-motion: reduce) {
      .frame, .mascot, .spk, .hull, .shadow, .lid, .log-row, .hl { animation: none }
      .mascot-wrap { transition: none }
      .ripple { animation-duration: 1ms }
    }
  `;

  // Kap: the Wisp mascot. A small floating bot whose eyes follow the
  // virtual cursor and whose mouth carries the mood.
  // Wisp: a round little ghost. Its hem ripples, it blinks, its sparkles
  // twinkle, its eyes follow the virtual cursor and its face carries the mood.
  const MASCOT_SVG = `
    <svg class="mascot" viewBox="0 0 58 66" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="wisp-body" x1=".2" y1="0" x2=".8" y2="1">
          <stop offset="0" stop-color="#fef3c7"/>
          <stop offset=".45" stop-color="#fcd34d"/>
          <stop offset="1" stop-color="#f59e0b"/>
        </linearGradient>
        <radialGradient id="wisp-halo" cx=".5" cy=".45" r=".5">
          <stop offset="0" stop-color="#fcd34d" stop-opacity=".5"/>
          <stop offset="1" stop-color="#f59e0b" stop-opacity="0"/>
        </radialGradient>
        <filter id="wisp-glow" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="2.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      <ellipse class="shadow" cx="29" cy="59" rx="11" ry="2.4" fill="rgba(245, 158, 11, .3)"/>
      <circle cx="29" cy="30" r="27" fill="url(#wisp-halo)"/>

      <g class="sparks" filter="url(#wisp-glow)" fill="#fef3c7">
        <path class="spk a" d="M50 15l1.1 2.9L54 19l-2.9 1.1L50 23l-1.1-2.9L46 19l2.9-1.1Z"/>
        <path class="spk b" d="M7.5 25l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3L4.3 28l2.3-.9Z"/>
        <path class="spk c" d="M47.5 43l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>
      </g>

      <g class="body">
        <path class="hull" d="M29 5c11.6 0 20 8.6 20 20.5V46q-6.7 8-13.3 0q-6.7 8-13.3 0q-6.7 8-13.4 0V25.5C9 13.6 17.4 5 29 5Z" fill="url(#wisp-body)"/>
        <path d="M29 5c11.6 0 20 8.6 20 20.5v3c-2.4-9.6-10-16-20-16s-17.6 6.4-20 16v-3C9 13.6 17.4 5 29 5Z" fill="#fffbeb" fill-opacity=".5"/>
      </g>

      <g class="blush" fill="#fb7185" fill-opacity=".45">
        <ellipse cx="16.5" cy="33" rx="3.6" ry="2.3"/>
        <ellipse cx="41.5" cy="33" rx="3.6" ry="2.3"/>
      </g>

      <g class="eyes">
        <g class="eyes-open">
          <ellipse cx="22" cy="26" rx="4.6" ry="5.6" fill="#231709"/>
          <ellipse cx="36" cy="26" rx="4.6" ry="5.6" fill="#231709"/>
          <circle cx="23.7" cy="23.6" r="1.6" fill="#fffbeb"/>
          <circle cx="37.7" cy="23.6" r="1.6" fill="#fffbeb"/>
          <circle cx="20.6" cy="28.4" r=".9" fill="#fffbeb" fill-opacity=".7"/>
          <circle cx="34.6" cy="28.4" r=".9" fill="#fffbeb" fill-opacity=".7"/>
          <rect class="lid" x="16.5" y="19" width="11" height="14" rx="4" fill="#fcd34d"/>
          <rect class="lid" x="30.5" y="19" width="11" height="14" rx="4" fill="#fcd34d"/>
        </g>
        <g class="eyes-happy" stroke="#231709" stroke-width="2.6" stroke-linecap="round" fill="none">
          <path d="M18.4 27.4q3.6-5 7.2 0"/>
          <path d="M32.4 27.4q3.6-5 7.2 0"/>
        </g>
      </g>

      <g class="mouth" fill="#231709">
        <path class="mouth-idle" d="M26 35.5q3 2.6 6 0q-3 4.4-6 0Z"/>
        <path class="mouth-busy" d="M25.2 35q3.8 6.4 7.6 0Z"/>
        <path class="mouth-happy" d="M24.4 34.6q4.6 7.6 9.2 0Z"/>
        <path class="mouth-oops" d="M25 38.4q4-5 8 0q-4-2.4-8 0Z"/>
      </g>
    </svg>`;

  const CURSOR_SVG = `
    <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 0 L0 16 L4.5 12.5 L7.5 20 L10 19 L7 11.5 L12 11 Z"
            fill="white" stroke="black" stroke-width="1"/>
    </svg>`;

  function ensure() {
    if (!host) {
      host = document.createElement('wisp-overlay');
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>${STYLE}</style>
        <div class="layer mood-idle">
          <div class="frame"></div>
          <div class="cursor" hidden>${CURSOR_SVG}</div>
          <div class="log"></div>
          <div class="mascot-wrap">
            <div class="bubble"><b>Wisp</b> is driving this tab</div>
            ${MASCOT_SVG}
          </div>
        </div>`;
      root.querySelector('.mascot-wrap').hidden = !mascotEnabled;
      scheduleBlink();
    }
    // Attach under <html> so body.outerHTML stays clean; re-attach if a page
    // (or SPA re-render) removed it.
    if (!host.isConnected && document.documentElement) {
      document.documentElement.appendChild(host);
    }
    return root;
  }

  const $ = (sel) => ensure().querySelector(sel);

  function setMood(mood, holdMs = MOOD_MS) {
    const layer = $('.layer');
    layer.classList.remove('mood-idle', 'mood-busy', 'mood-happy', 'mood-oops');
    layer.classList.add(`mood-${mood}`);
    clearTimeout(moodTimer);
    if (mood === 'happy' || mood === 'oops') {
      moodTimer = setTimeout(() => setMood('busy'), holdMs);
    }
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      const layer = host && $('.layer');
      if (layer) {
        layer.classList.add('blinking');
        setTimeout(() => layer.classList.remove('blinking'), 200);
      }
      scheduleBlink();
    }, 2600 + Math.random() * 3200);
  }

  // Eyes track the virtual cursor: a few pixels of travel is enough to read as
  // "it is looking over there".
  function lookAt(x, y) {
    if (!ghost) return;
    const dx = Math.max(-1, Math.min(1, (x - (ghost.x + GHOST_W / 2)) / 260));
    const dy = Math.max(-1, Math.min(1, (y - (ghost.y + GHOST_H / 2)) / 260));
    $('.eyes').style.transform = `translate(${(dx * 2.6).toFixed(2)}px, ${(dy * 2).toFixed(2)}px)`;
  }

  // Move the wisp so it hovers near (x, y) without sitting on top of it. It
  // flips to the other side when it would fly off the right edge.
  function flyTo(x, y, { near = true } = {}) {
    const wrap = $('.mascot-wrap');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const offsetX = near ? 26 : 0;
    const offsetY = near ? -GHOST_H - 10 : 0;

    let left = x + offsetX;
    let top = y + offsetY;
    const flip = left + GHOST_W + 190 > vw; // 190 = bubble headroom
    if (flip) left = x - GHOST_W - offsetX;

    left = Math.max(MARGIN, Math.min(vw - GHOST_W - MARGIN, left));
    top = Math.max(MARGIN, Math.min(vh - GHOST_H - MARGIN, top));

    wrap.classList.toggle('flip', flip);
    wrap.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    ghost = { x: left, y: top };
  }

  // Idle: drift around the page instead of parking in one corner
  function wander() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = MARGIN + Math.random() * Math.max(1, vw - GHOST_W - MARGIN * 2);
    const y = MARGIN + Math.random() * Math.max(1, vh - GHOST_H - MARGIN * 2);
    flyTo(x, y, { near: false });
  }

  function startWander() {
    clearInterval(wanderTimer);
    wanderTimer = setInterval(() => {
      const layer = host && $('.layer');
      if (layer && layer.classList.contains('idle')) wander();
    }, 4200);
  }

  const pad = (n) => String(n).padStart(2, '0');

  function logLine(what, detail, ok = true) {
    if (!logEnabled) return;
    const log = $('.log');
    const now = new Date();

    const row = document.createElement('div');
    row.className = `log-row${ok ? '' : ' err'}`;
    const time = document.createElement('time');
    time.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const label = document.createElement('span');
    label.className = 'what';
    label.textContent = what;
    row.append(time, label);
    if (detail) {
      const extra = document.createElement('span');
      extra.className = 'detail';
      extra.textContent = detail;
      row.append(extra);
    }

    log.prepend(row);
    log.classList.add('show');

    // Keep the newest six; the oldest two fade out before they go
    const rows = [...log.children];
    rows.forEach((el, i) => {
      el.classList.toggle('fade', i === 4);
      el.classList.toggle('fade-more', i === 5);
    });
    rows.slice(6).forEach((el) => el.remove());
  }

  function markBusy() {
    const layer = $('.layer');
    layer.classList.add('busy');
    layer.classList.remove('idle');
    if (!/mood-(happy|oops)/.test(layer.className)) setMood('busy');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      layer.classList.remove('busy');
      layer.classList.add('idle');
      setMood('idle');
      say('watching this tab');
      wander();
    }, IDLE_MS);
  }

  function say(text, emphasis = 'Wisp') {
    const bubble = $('.bubble');
    bubble.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = emphasis;
    bubble.append(b, ` ${text}`);
    bubble.classList.add('show');
  }

  window.addEventListener('resize', () => {
    if (host && ghost) flyTo(ghost.x, ghost.y, { near: false });
  });

  return {
    setActive(on) {
      active = on;
      if (!on && !host) return;
      const layer = $('.layer');
      layer.classList.toggle('active', on);
      if (on) {
        layer.classList.add('idle');
        say('is driving this tab');
        if (!ghost) flyTo(window.innerWidth - 120, window.innerHeight - 120, { near: false });
        startWander();
        logLine('connected', location.host);
      } else {
        clearTimeout(idleTimer);
        clearTimeout(moodTimer);
        clearInterval(wanderTimer);
        $('.cursor').hidden = true;
        $('.bubble').classList.remove('show');
        $('.log').classList.remove('show');
        $('.log').textContent = '';
      }
    },

    setLog(on) {
      logEnabled = on !== false;
      if (!host) return;
      $('.log').hidden = !logEnabled;
    },

    setMascot(on) {
      mascotEnabled = on !== false;
      // Nothing built yet: ensure() applies the setting when it builds
      if (host) $('.mascot-wrap').hidden = !mascotEnabled;
    },

    activity(label, detail) {
      if (!active) return;
      say(label ? `is ${label.toLowerCase()}` : 'is working');
      logLine(label ? label.toLowerCase() : 'working', detail);
      markBusy();
    },

    // Called when a command finished: 'happy' on success, 'oops' on error
    outcome(ok) {
      if (!active) return;
      setMood(ok === false ? 'oops' : 'happy');
      if (ok === false) {
        say('hit an error', 'Wisp');
        logLine('failed', '', false);
      }
      markBusy();
    },

    showCursor(show) {
      const cursor = $('.cursor');
      if (show) {
        cursor.hidden = false;
        $('.layer').classList.add('active');
        markBusy();
      } else if (!active) {
        // Not under remote control: the cursor only lives for the command
        cursor.hidden = true;
        $('.layer').classList.remove('active');
      }
      // While connected the cursor stays put; the idle timer dims it.
      return cursorPos;
    },

    moveCursor(x, y, duration) {
      const cursor = $('.cursor');
      cursor.style.transition = duration > 0
        ? `transform ${duration}ms cubic-bezier(.25, .46, .45, .94), opacity .3s ease`
        : 'opacity .3s ease';
      cursor.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
      cursorPos = { x, y };
      flyTo(x, y);
      lookAt(x, y);
      markBusy();
    },

    clickEffect(x, y) {
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.setProperty('--at', `translate(${x}px, ${y}px)`);
      $('.layer').appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
      setTimeout(() => ripple.remove(), 1000); // fallback if animations are off
      markBusy();
    },

    // Draw boxes over elements so a human can see what the client picked
    highlight(boxes, label, durationMs = 2500) {
      const layer = $('.layer');
      layer.classList.add('active');
      const drawn = boxes.map((box) => {
        const el = document.createElement('div');
        el.className = 'hl';
        el.style.cssText = `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`;
        if (label) {
          const tag = document.createElement('div');
          tag.className = 'hl-tag';
          tag.textContent = label;
          el.appendChild(tag);
        }
        layer.appendChild(el);
        return el;
      });
      setTimeout(() => drawn.forEach((el) => el.remove()), Math.max(0, durationMs));
      markBusy();
    },

    // Hide for screenshots so captures show the page as-is
    setCapturing(on) {
      if (!host) return;
      $('.layer').classList.toggle('capturing', on);
    },
  };
})();
