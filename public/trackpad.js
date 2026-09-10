// Virtual trackpad for the 2004Scape web client.
// A strip below the canvas moves a virtual cursor over the fixed 765x503
// client surface; taps/clicks are dispatched to the canvas as synthetic
// pointer/mouse events with pointerType 'mouse' (the desktop input path),
// so no client.js changes are involved.
// Modes: 'off' | 'tap' (1-finger tap=LMB, 2-finger tap=RMB)
//      | 'buttons' (tap clicks + hold-to-drag LMB / hold-to-menu RMB buttons).

export const CLIENT_WIDTH = 765;
export const CLIENT_HEIGHT = 503;
export const SENSITIVITY = 1.6;

export function clampCursor(x, y) {
    return {
        x: Math.max(0, Math.min(CLIENT_WIDTH, x | 0)),
        y: Math.max(0, Math.min(CLIENT_HEIGHT, y | 0))
    };
}

export function cursorToCss(vx, vy, rect) {
    return {
        x: rect.left + (vx / CLIENT_WIDTH) * rect.width,
        y: rect.top + (vy / CLIENT_HEIGHT) * rect.height
    };
}

export function classifyTap(maxPointers, durationMs, maxDistPx) {
    if (durationMs > 250 || maxDistPx > 12) {
        return 0;
    }
    return maxPointers >= 2 ? 2 : 1;
}

// ---- DOM wiring (skipped when imported under Node for unit tests) ----
if (typeof document !== 'undefined') {
    const canvas = document.getElementById('canvas');
    const zone = document.getElementById('trackpad-zone');
    const btnL = document.getElementById('trackpad-lmb');
    const btnR = document.getElementById('trackpad-rmb');

    // position:fixed => viewport coords, same space as getBoundingClientRect()
    const cursorEl = document.createElement('div');
    cursorEl.id = 'trackpad-cursor';
    document.body.appendChild(cursorEl);

    let mode = 'off';
    let vx = CLIENT_WIDTH / 2;
    let vy = CLIENT_HEIGHT / 2;
    let heldButton = -1;          // 0 = LMB, 2 = RMB, -1 = none
    const active = new Map();     // pointerId -> { x0, y0, x, y, t0 }
    let maxPointers = 0;

    function positionCursor() {
        const p = cursorToCss(vx, vy, canvas.getBoundingClientRect());
        cursorEl.style.left = p.x + 'px';
        cursorEl.style.top = p.y + 'px';
    }

    function dispatch(type, button, buttons) {
        const p = cursorToCss(vx, vy, canvas.getBoundingClientRect());
        const init = {
            bubbles: true,
            cancelable: true,
            clientX: p.x,
            clientY: p.y,
            screenX: p.x,
            screenY: p.y,
            button: button,
            buttons: buttons
        };
        if (type.startsWith('pointer')) {
            init.pointerId = 1;
            init.pointerType = 'mouse';
            init.isPrimary = true;
            canvas.dispatchEvent(new PointerEvent(type, init));
        } else {
            canvas.dispatchEvent(new MouseEvent(type, init));
        }
    }

    function click(button) {
        dispatch('pointerdown', button, button === 2 ? 2 : 1);
        dispatch('mousedown', button, button === 2 ? 2 : 1);
        setTimeout(() => {
            dispatch('pointerup', button, 0);
            dispatch('mouseup', button, 0);
        }, 40);
    }

    function press(button) {
        if (heldButton === button) return;
        if (heldButton >= 0) release();
        heldButton = button;
        dispatch('pointerdown', button, button === 2 ? 2 : 1);
        dispatch('mousedown', button, button === 2 ? 2 : 1);
    }

    function release() {
        if (heldButton < 0) return;
        const b = heldButton;
        heldButton = -1;
        dispatch('pointerup', b, 0);
        dispatch('mouseup', b, 0);
    }

    function moveFrom(e) {
        const t = active.get(e.pointerId);
        if (!t) return;
        e.preventDefault();
        const dx = (e.clientX - t.x) * SENSITIVITY;
        const dy = (e.clientY - t.y) * SENSITIVITY;
        t.x = e.clientX;
        t.y = e.clientY;
        const c = clampCursor(vx + dx, vy + dy);
        vx = c.x;
        vy = c.y;
        positionCursor();
        dispatch('pointermove', 0, heldButton === 2 ? 2 : heldButton === 0 ? 1 : 0);
    }

    zone.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (zone.setPointerCapture) {
            try { zone.setPointerCapture(e.pointerId); } catch { /* synthetic pointer id */ }
        }
        active.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: e.timeStamp });
        maxPointers = Math.max(maxPointers, active.size);
    });

    zone.addEventListener('pointermove', moveFrom);

    function endPointer(e, cancelled) {
        const t = active.get(e.pointerId);
        if (!t) return;
        active.delete(e.pointerId);
        if (active.size === 0) {
            if (!cancelled && heldButton < 0) {
                const dist = Math.hypot(e.clientX - t.x0, e.clientY - t.y0);
                const b = classifyTap(maxPointers, e.timeStamp - t.t0, dist);
                if (b) click(b);
            }
            maxPointers = 0;
        }
    }
    zone.addEventListener('pointerup', e => endPointer(e, false));
    zone.addEventListener('pointercancel', e => endPointer(e, true));

    function wireButton(el, button) {
        el.addEventListener('pointerdown', e => {
            e.preventDefault();
            e.stopPropagation();
            active.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: e.timeStamp });
            el.classList.add('active');
            press(button);
        });
        // a finger held on the button drives the cursor: hold + move = drag
        el.addEventListener('pointermove', moveFrom);
        const up = e => {
            if (e.pointerId !== undefined) active.delete(e.pointerId);
            if (active.size === 0) maxPointers = 0;
            el.classList.remove('active');
            release();
        };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
    }
    wireButton(btnL, 0);
    wireButton(btnR, 2);

    function matchWidth() {
        zone.style.width = Math.max(200, canvas.offsetWidth) + 'px';
    }
    window.addEventListener('resize', () => {
        matchWidth();
        positionCursor();
    });

    function applyMode(m) {
        mode = (m === 'tap' || m === 'buttons') ? m : 'off';
        const on = mode !== 'off';
        zone.style.display = on ? 'flex' : 'none';
        btnL.style.display = btnR.style.display = (mode === 'buttons') ? '' : 'none';
        cursorEl.style.display = on ? 'block' : 'none';
        if (on) {
            requestAnimationFrame(() => {
                matchWidth();
                positionCursor();
            });
        }
        // only 'auto' sizing reserves strip height; never mutate other size prefs
        if (localStorage.getItem('canvasSize') === 'auto' && typeof window.setSize === 'function') {
            window.setSize('auto');
        }
    }

    const forced = new URLSearchParams(location.search).get('trackpad');
    applyMode(forced || localStorage.getItem('trackpadMode') || 'off');
    // the toggle label lives in the page script; refresh it now that mode is applied
    if (typeof window.updateTrackpadToggle === 'function') { window.updateTrackpadToggle(); }

    window.__trackpad = { applyMode: applyMode, state: () => ({ mode: mode, vx: vx, vy: vy }) };
}
