// Animated background themes ("space", "aurora", "dark") for the Webblox launcher.
// Runs only while the launcher is open so gameplay gets 100% of CPU/GPU.

export const THEMES = ["space", "aurora", "dark"];

let activeStop = null;

export function stopThemeBackground(canvas) {
  if (activeStop) {
    activeStop();
    activeStop = null;
  }
  if (canvas) canvas.hidden = true;
}

export function startThemeBackground(canvas, theme) {
  stopThemeBackground(canvas);
  const chosen = THEMES.includes(theme) ? theme : "space";
  document.body.dataset.theme = chosen;
  if (!canvas || chosen === "dark") return () => {};

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return () => {};

  canvas.hidden = false;
  let width = 0;
  let height = 0;
  let rafId = 0;
  let stopped = false;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  // Shared starfield
  const stars = Array.from({ length: chosen === "space" ? 170 : 90 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.5 + Math.random() * 1.6,
    speed: 0.000015 + Math.random() * 0.00005,
    phase: Math.random() * Math.PI * 2,
    twinkle: 0.8 + Math.random() * 2.2,
    hue: Math.random() < 0.2 ? 215 : Math.random() < 0.15 ? 275 : 210,
  }));

  let shootingStar = null;
  let nextMeteorAt = performance.now() + 2500;

  const renderSpace = (now) => {
    const t = now * 0.001;
    const bg = ctx.createRadialGradient(width * 0.65, height * 0.25, 40, width * 0.5, height * 0.5, Math.max(width, height));
    bg.addColorStop(0, "#0b1230");
    bg.addColorStop(0.5, "#06091b");
    bg.addColorStop(1, "#02030a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Drifting nebula glows
    const nx1 = width * (0.25 + Math.sin(t * 0.08) * 0.06);
    const ny1 = height * (0.32 + Math.cos(t * 0.06) * 0.05);
    const neb1 = ctx.createRadialGradient(nx1, ny1, 10, nx1, ny1, Math.max(width, height) * 0.42);
    neb1.addColorStop(0, "rgba(104, 72, 245, 0.22)");
    neb1.addColorStop(0.5, "rgba(62, 110, 255, 0.08)");
    neb1.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = neb1;
    ctx.fillRect(0, 0, width, height);

    const nx2 = width * (0.76 + Math.cos(t * 0.07) * 0.06);
    const ny2 = height * (0.68 + Math.sin(t * 0.09) * 0.05);
    const neb2 = ctx.createRadialGradient(nx2, ny2, 10, nx2, ny2, Math.max(width, height) * 0.38);
    neb2.addColorStop(0, "rgba(28, 178, 255, 0.16)");
    neb2.addColorStop(0.55, "rgba(74, 52, 190, 0.06)");
    neb2.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = neb2;
    ctx.fillRect(0, 0, width, height);

    // Twinkling stars
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.x -= s.speed;
      if (s.x < 0) s.x = 1;
      const alpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.twinkle + s.phase));
      ctx.fillStyle = `hsla(${s.hue}, 85%, 92%, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(s.x * width, s.y * height, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Occasional shooting star
    if (!shootingStar && now > nextMeteorAt) {
      shootingStar = {
        x: width * (0.2 + Math.random() * 0.7),
        y: height * (0.05 + Math.random() * 0.35),
        vx: -10 - Math.random() * 6,
        vy: 4 + Math.random() * 3,
        life: 1,
      };
      nextMeteorAt = now + 4500 + Math.random() * 5500;
    }
    if (shootingStar) {
      const m = shootingStar;
      const grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 10, m.y - m.vy * 10);
      grad.addColorStop(0, `rgba(220, 238, 255, ${m.life})`);
      grad.addColorStop(1, "rgba(120, 160, 255, 0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(m.x - m.vx * 10, m.y - m.vy * 10);
      ctx.stroke();
      m.x += m.vx;
      m.y += m.vy;
      m.life -= 0.025;
      if (m.life <= 0) shootingStar = null;
    }
  };

  const ribbons = [
    { y: 0.34, amp: 58, freq: 0.0032, speed: 0.38, height: 220, colors: ["rgba(24, 245, 168, 0.34)", "rgba(20, 210, 255, 0.14)", "rgba(0,0,0,0)"] },
    { y: 0.28, amp: 46, freq: 0.0045, speed: -0.28, height: 250, colors: ["rgba(40, 225, 255, 0.26)", "rgba(128, 86, 255, 0.15)", "rgba(0,0,0,0)"] },
    { y: 0.42, amp: 66, freq: 0.0024, speed: 0.22, height: 200, colors: ["rgba(56, 255, 178, 0.24)", "rgba(92, 60, 225, 0.12)", "rgba(0,0,0,0)"] },
    { y: 0.22, amp: 38, freq: 0.0052, speed: 0.46, height: 180, colors: ["rgba(154, 92, 255, 0.22)", "rgba(24, 232, 185, 0.10)", "rgba(0,0,0,0)"] },
  ];

  const renderAurora = (now) => {
    const t = now * 0.001;
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#020812");
    sky.addColorStop(0.55, "#041620");
    sky.addColorStop(1, "#061d24");
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // High-altitude stars
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const alpha = 0.2 + 0.55 * (0.5 + 0.5 * Math.sin(t * s.twinkle + s.phase));
      ctx.fillStyle = `rgba(225, 248, 255, ${alpha.toFixed(2)})`;
      ctx.fillRect(s.x * width, s.y * height * 0.72, s.r, s.r);
    }

    // Flowing aurora borealis curtains
    ctx.globalCompositeOperation = "screen";
    const step = 28;
    for (let r = 0; r < ribbons.length; r++) {
      const rib = ribbons[r];
      const baseY = height * rib.y;
      const grad = ctx.createLinearGradient(0, baseY - rib.height * 0.85, 0, baseY + rib.height * 0.45);
      grad.addColorStop(0, rib.colors[2]);
      grad.addColorStop(0.35, rib.colors[1]);
      grad.addColorStop(0.78, rib.colors[0]);
      grad.addColorStop(1, rib.colors[2]);

      ctx.fillStyle = grad;
      ctx.beginPath();
      for (let x = 0; x <= width + step; x += step) {
        const wave =
          Math.sin(x * rib.freq + t * rib.speed + r) * rib.amp +
          Math.cos(x * rib.freq * 1.9 - t * rib.speed * 0.7) * (rib.amp * 0.45);
        const y = baseY + wave;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let x = width + step; x >= 0; x -= step) {
        const wave =
          Math.sin(x * rib.freq + t * rib.speed + r) * rib.amp +
          Math.cos(x * rib.freq * 1.9 - t * rib.speed * 0.7) * (rib.amp * 0.45);
        ctx.lineTo(x, baseY + wave - rib.height);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const loop = (now) => {
    if (stopped) return;
    if (!document.hidden) {
      if (chosen === "space") renderSpace(now);
      else renderAurora(now);
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  activeStop = () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", resize);
  };
  return activeStop;
}
