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
    .mascot-wrap {
      position: absolute; right: 18px; bottom: 18px;
      display: flex; align-items: flex-end; gap: 8px;
      transition: opacity .3s ease, transform .3s ease;
    }
    .layer.idle .mascot-wrap { opacity: .75; }
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

    .wisp-spark { animation: drift 3.1s ease-in-out infinite; transform-origin: center }
    .wisp-spark.b { animation-duration: 2.3s; animation-delay: -.8s }
    .layer.busy .wisp-spark { animation-duration: 1.2s }
    @keyframes drift {
      0%, 100% { opacity: .25; transform: translate(0, 0) }
      50% { opacity: .9; transform: translate(-2px, -5px) }
    }

    .tail path { animation: wave 2.8s ease-in-out infinite }
    .layer.busy .tail path { animation-duration: 1.3s }
    @keyframes wave {
      0%, 100% { d: path("M8 46q5 7 10.5 0t10.5 0 10.5 0 10.5 0V34H8Z") }
      50% { d: path("M8 46q5 0 10.5 0t10.5 7 10.5 0 10.5 7V34H8Z") }
    }

    .eyes { transition: transform .25s cubic-bezier(.2, .9, .3, 1) }
    .lid { transform: scaleY(0); transform-origin: center; transform-box: fill-box; }
    .blinking .lid { animation: blink .18s ease-in-out; }
    @keyframes blink { 0%, 100% { transform: scaleY(0) } 50% { transform: scaleY(1) } }

    .mouth { transition: d .2s ease, opacity .2s ease }
    .mouth-idle, .mouth-busy, .mouth-happy, .mouth-oops { opacity: 0 }
    .mood-idle .mouth-idle,
    .mood-busy .mouth-busy,
    .mood-happy .mouth-happy,
    .mood-oops .mouth-oops { opacity: 1 }

    .spark { opacity: 0 }
    .mood-happy .spark { animation: spark .9s ease-out }
    @keyframes spark {
      0% { opacity: 0; transform: scale(.4) }
      35% { opacity: 1; transform: scale(1) }
      100% { opacity: 0; transform: scale(1.3) }
    }

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

    @media (prefers-reduced-motion: reduce) {
      .frame, .mascot, .wisp-spark, .tail path, .lid, .spark { animation: none }
      .ripple { animation-duration: 1ms }
    }
  `;

  // Kap: the Wisp mascot. A small floating bot whose eyes follow the
  // virtual cursor and whose mouth carries the mood.
  // Wisp: a small drifting flame-ghost. Its eyes follow the virtual cursor and
  // its mouth carries the mood.
  const MASCOT_SVG = `
    <svg class="mascot" viewBox="0 0 58 66" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="wisp-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fde68a"/>
          <stop offset=".55" stop-color="#fbbf24"/>
          <stop offset="1" stop-color="#f59e0b"/>
        </linearGradient>
        <radialGradient id="wisp-halo" cx=".5" cy=".45" r=".55">
          <stop offset="0" stop-color="#fcd34d" stop-opacity=".55"/>
          <stop offset="1" stop-color="#f59e0b" stop-opacity="0"/>
        </radialGradient>
        <filter id="wisp-glow" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="2.6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      <ellipse cx="29" cy="62" rx="13" ry="3" fill="rgba(245, 158, 11, .28)"/>
      <circle cx="29" cy="30" r="27" fill="url(#wisp-halo)"/>

      <g filter="url(#wisp-glow)">
        <circle class="wisp-spark" cx="47" cy="20" r="2.6" fill="#fde68a"/>
        <circle class="wisp-spark b" cx="11" cy="27" r="1.8" fill="#fcd34d"/>
      </g>

      <g class="tail">
        <path d="M8 46q5 7 10.5 0t10.5 0 10.5 0 10.5 0V34H8Z" fill="url(#wisp-body)"/>
      </g>
      <path d="M29 6c11.6 0 21 9 21 20.5V40H8V26.5C8 15 17.4 6 29 6Z" fill="url(#wisp-body)"/>
      <path d="M29 6c11.6 0 21 9 21 20.5V30c-3-9-11-15-21-15s-18 6-21 15v-3.5C8 15 17.4 6 29 6Z" fill="rgba(255, 251, 235, .45)"/>

      <g class="eyes">
        <ellipse cx="21" cy="27" rx="4" ry="5" fill="#1c1409"/>
        <ellipse cx="37" cy="27" rx="4" ry="5" fill="#1c1409"/>
        <circle cx="22.6" cy="25" r="1.3" fill="#fffbeb"/>
        <circle cx="38.6" cy="25" r="1.3" fill="#fffbeb"/>
        <rect class="lid" x="16" y="21" width="10" height="12" rx="3" fill="#fbbf24"/>
        <rect class="lid" x="32" y="21" width="10" height="12" rx="3" fill="#fbbf24"/>
      </g>

      <g class="mouth" stroke="#1c1409" stroke-width="2" stroke-linecap="round" fill="none">
        <path class="mouth-idle" d="M25 36h8"/>
        <path class="mouth-busy" d="M24 35q5 4 10 0"/>
        <path class="mouth-happy" d="M23 34q6 7 12 0"/>
        <path class="mouth-oops" d="M24 37q5-4 10 0"/>
      </g>

      <g class="spark" fill="#fffbeb">
        <path d="M48 10l1.4 3.4L53 15l-3.6 1.6L48 20l-1.4-3.4L43 15l3.6-1.6Z"/>
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
    const eyes = $('.eyes');
    const rect = $('.mascot').getBoundingClientRect();
    if (!rect.width) return;
    const dx = Math.max(-1, Math.min(1, (x - (rect.left + rect.width / 2)) / 420));
    const dy = Math.max(-1, Math.min(1, (y - (rect.top + rect.height / 2)) / 420));
    eyes.style.transform = `translate(${(dx * 2.6).toFixed(2)}px, ${(dy * 2).toFixed(2)}px)`;
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

  return {
    setActive(on) {
      active = on;
      if (!on && !host) return;
      const layer = $('.layer');
      layer.classList.toggle('active', on);
      if (on) {
        layer.classList.add('idle');
        say('is driving this tab');
      } else {
        clearTimeout(idleTimer);
        clearTimeout(moodTimer);
        $('.cursor').hidden = true;
        $('.bubble').classList.remove('show');
      }
    },

    setMascot(on) {
      mascotEnabled = on !== false;
      // Nothing built yet: ensure() applies the setting when it builds
      if (host) $('.mascot-wrap').hidden = !mascotEnabled;
    },

    activity(label) {
      if (!active) return;
      say(label ? `is ${label.toLowerCase()}` : 'is working');
      markBusy();
    },

    // Called when a command finished: 'happy' on success, 'oops' on error
    outcome(ok) {
      if (!active) return;
      setMood(ok === false ? 'oops' : 'happy');
      if (ok === false) say('hit an error', 'Wisp');
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

    // Hide for screenshots so captures show the page as-is
    setCapturing(on) {
      if (!host) return;
      $('.layer').classList.toggle('capturing', on);
    },
  };
})();
