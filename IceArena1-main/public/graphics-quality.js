(() => {
  const STORAGE_KEY = "icearena_graphics_quality_v1";
  const allowed = new Set(["eco", "balanced", "high"]);
  const root = document.documentElement;

  function readSavedQuality() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return allowed.has(value) ? value : null;
    } catch {
      return null;
    }
  }

  function detectDefaultQuality() {
    const cores = Number(navigator.hardwareConcurrency) || 0;
    const memory = Number(navigator.deviceMemory) || 0;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    return reducedMotion || (cores > 0 && cores <= 4) || (memory > 0 && memory <= 4) ? "eco" : "balanced";
  }

  function renderQualityControls(quality) {
    document.querySelectorAll("[data-graphics-quality-choice]").forEach(button => {
      const selected = button.dataset.graphicsQualityChoice === quality;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    const status = document.getElementById("graphicsQualityStatus");
    if (status) {
      status.textContent = quality === "eco" ? "Эффекты снижены для плавной работы"
        : quality === "high" ? "Включены все визуальные эффекты"
          : "Сбалансированная графика";
    }
  }

  function applyQuality(quality, save = false) {
    if (!allowed.has(quality)) return;
    root.dataset.graphicsQuality = quality;
    window.graphicsQuality = quality;
    renderQualityControls(quality);
    if (save) {
      try { localStorage.setItem(STORAGE_KEY, quality); } catch {}
    }
    window.dispatchEvent(new CustomEvent("graphicsqualitychange", { detail: { quality } }));
  }

  // Limit actual wake-ups as well as painting. Skipping frames inside a continuous
  // requestAnimationFrame loop still wakes the JS thread at the display refresh rate.
  const refreshSlackMs = 1000 / 60;
  window.graphicsQualityStats = {
    eco: { frames: 0, renderMs: 0 },
    balanced: { frames: 0, renderMs: 0 },
    high: { frames: 0, renderMs: 0 }
  };
  window.requestGraphicsFrame = callback => {
    const quality = root.dataset.graphicsQuality || "balanced";
    const fps = quality === "eco" ? 30 : quality === "balanced" ? 45 : 0;
    const run = timestamp => {
      const startedAt = performance.now();
      try { callback(timestamp); }
      finally {
        const stats = window.graphicsQualityStats[quality];
        stats.frames++;
        stats.renderMs += performance.now() - startedAt;
      }
    };
    if (!fps) return requestAnimationFrame(run);
    const delay = Math.max(0, 1000 / fps - refreshSlackMs);
    return setTimeout(() => requestAnimationFrame(run), delay);
  };

  applyQuality(readSavedQuality() || detectDefaultQuality());

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-graphics-quality-choice]");
    if (button) applyQuality(button.dataset.graphicsQualityChoice, true);
  });

  document.addEventListener("DOMContentLoaded", () => renderQualityControls(root.dataset.graphicsQuality));
})();
