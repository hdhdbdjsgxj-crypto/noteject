(() => {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;

  canvas.className = 'scroll-node-field';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let nodes = [];
  let energy = 0;
  let lastY = window.scrollY;
  let lastTime = performance.now();
  let frame = 0;

  function createNodes() {
    let seed = ((width * 73856093) ^ (height * 19349663)) >>> 0;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const count = Math.max(28, Math.min(76, Math.round(width * height / 15000)));
    nodes = Array.from({ length: count }, () => ({
      x: random() * width,
      y: random() * height,
      phase: random() * Math.PI * 2
    }));
  }

  function resize() {
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    createNodes();
    requestDraw();
  }

  function render() {
    frame = 0;
    context.clearRect(0, 0, width, height);
    const motion = reducedMotion.matches ? 0 : energy;
    const scrollOffset = reducedMotion.matches ? 0 : (window.scrollY * 0.09) % height;
    const time = performance.now() / 1000;
    const points = nodes.map(node => ({
      x: node.x + Math.sin(time * 0.22 + node.phase) * motion * 2.2,
      y: (node.y - scrollOffset + height) % height,
      phase: node.phase
    }));
    const reach = Math.min(158, Math.max(108, width * 0.22));

    context.lineWidth = 0.8 + motion * 0.55;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const b = points[j];
        const dx = a.x - b.x;
        let dy = a.y - b.y;
        if (Math.abs(dy) > height / 2) dy -= Math.sign(dy) * height;
        const distance = Math.hypot(dx, dy);
        if (distance > reach) continue;
        const alpha = (1 - distance / reach) * (0.06 + motion * 0.19);
        context.strokeStyle = `rgba(174, 157, 239, ${alpha.toFixed(3)})`;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y + (Math.abs(a.y - b.y) > height / 2 ? Math.sign(a.y - b.y) * height : 0));
        context.stroke();
      }
    }

    for (const point of points) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 1.3 + point.phase);
      const radius = 1.1 + motion * (1.5 + pulse);
      context.beginPath();
      context.arc(point.x, point.y, radius * (2 + motion), 0, Math.PI * 2);
      context.fillStyle = `rgba(115, 213, 219, ${(0.025 + motion * 0.10).toFixed(3)})`;
      context.fill();
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(207, 194, 255, ${(0.18 + pulse * 0.12 + motion * 0.35).toFixed(3)})`;
      context.fill();
    }

    energy *= 0.88;
    if (!reducedMotion.matches && energy > 0.012) frame = window.requestAnimationFrame(render);
  }

  function requestDraw() {
    if (!frame) frame = window.requestAnimationFrame(render);
  }

  function onScroll() {
    const now = performance.now();
    const y = window.scrollY;
    const elapsed = Math.max(16, now - lastTime);
    const delta = y - lastY;
    if (delta) {
      energy = Math.max(energy, Math.min(1, Math.abs(delta) / Math.max(36, elapsed * 0.75)));
      lastY = y;
      lastTime = now;
      requestDraw();
    }
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    } else if (!document.hidden) requestDraw();
  });
  reducedMotion.addEventListener?.('change', requestDraw);
  resize();
})();
