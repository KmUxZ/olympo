// Argos · script de contenido.
// Solo se inyecta en las herramientas de trabajo autorizadas y solo cuenta mientras hay un turno activo sin pausa.
//
// Qué hace:   cuenta eventos (cuántas teclas, cuántos clics, cuántos desplazamientos) y segundos con la pestaña en uso.
// Qué NO hace: nunca lee qué tecla se pulsó (no usa event.key ni event.code), ni texto, ni campos de formulario,
//              ni el portapapeles, ni la dirección de la página. No cuenta nada dentro de campos de contraseña.
(() => {
  if (globalThis.__argosLoaded) return;
  globalThis.__argosLoaded = true;

  const FLUSH_EVERY_SECONDS = 10;
  const ACTIVE_WINDOW_MS = 5000; // un segundo cuenta como "activo" si hubo algún evento en los 5 s anteriores

  let tracking = false;
  let timer = null;
  let ticks = 0;
  let lastInput = 0;
  let lastScrollCounted = 0;
  let acc = { focus: 0, active: 0, keys: 0, clicks: 0, scrolls: 0 };

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  function isSensitive(target) {
    if (!(target instanceof HTMLInputElement)) return false;
    if (target.type === 'password') return true;
    const ac = (target.getAttribute('autocomplete') || '').toLowerCase();
    return ac.includes('password') || ac.startsWith('cc-') || ac === 'one-time-code';
  }

  const onKey = (e) => {
    if (e.repeat || isSensitive(e.target)) return;
    acc.keys++;
    lastInput = Date.now();
  };
  const onPointer = (e) => {
    if (isSensitive(e.target)) return;
    acc.clicks++;
    lastInput = Date.now();
  };
  const onScroll = () => {
    const now = Date.now();
    if (now - lastScrollCounted >= 1000) {
      acc.scrolls++;
      lastScrollCounted = now;
    }
    lastInput = now;
  };
  const onMove = () => {
    lastInput = Date.now();
  };

  const LISTENERS = [
    ['keydown', onKey],
    ['pointerdown', onPointer],
    ['scroll', onScroll],
    ['wheel', onScroll],
    ['mousemove', onMove],
  ];

  function send(message) {
    if (!alive()) {
      stop(false);
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function flush() {
    const out = acc;
    acc = { focus: 0, active: 0, keys: 0, clicks: 0, scrolls: 0 };
    ticks = 0;
    if (!out.focus && !out.keys && !out.clicks && !out.scrolls) return;
    send({ type: 'argos:activity', ...out }).then((res) => {
      if (res && res.tracking === false) stop(false);
    });
  }

  function tick() {
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      acc.focus++;
      if (Date.now() - lastInput < ACTIVE_WINDOW_MS) acc.active++;
    }
    if (++ticks >= FLUSH_EVERY_SECONDS) flush();
  }

  function start() {
    if (tracking) return;
    tracking = true;
    for (const [type, fn] of LISTENERS) addEventListener(type, fn, { capture: true, passive: true });
    timer = setInterval(tick, 1000);
  }

  function stop(sendPending = true) {
    if (!tracking) return;
    tracking = false;
    for (const [type, fn] of LISTENERS) removeEventListener(type, fn, { capture: true });
    clearInterval(timer);
    timer = null;
    if (sendPending) flush();
    else acc = { focus: 0, active: 0, keys: 0, clicks: 0, scrolls: 0 };
  }

  function hello() {
    send({ type: 'argos:hello' }).then((res) => {
      if (res?.tracking) start();
      else stop(false);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'argos:tracking') return;
    if (message.on) start();
    else stop(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') hello();
    else if (tracking) flush();
  });
  addEventListener('pagehide', () => tracking && flush());

  hello();
})();
