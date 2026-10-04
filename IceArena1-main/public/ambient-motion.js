(() => {
  const app = document.querySelector(".app");
  const permissionButton = document.getElementById("ambientMotionBtn");
  if (!app || !("DeviceOrientationEvent" in window)) return;

  let listening = false;
  let frame = 0;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  const needsPermission = typeof DeviceOrientationEvent.requestPermission === "function";
  let hasPermission = !needsPermission;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function onOrientation(event) {
    if (event.gamma == null || event.beta == null) return;
    targetX = clamp(event.gamma / 40, -1, 1) * 13;
    targetY = clamp((event.beta - 35) / 45, -1, 1) * 13;
    if (!frame) frame = requestAnimationFrame(animateTilt);
  }

  function animateTilt() {
    currentX += (targetX - currentX) * 0.12;
    currentY += (targetY - currentY) * 0.12;
    app.style.setProperty("--ambient-tilt-x", `${currentX.toFixed(2)}px`);
    app.style.setProperty("--ambient-tilt-y", `${currentY.toFixed(2)}px`);
    if (Math.abs(targetX - currentX) > 0.08 || Math.abs(targetY - currentY) > 0.08) {
      frame = requestAnimationFrame(animateTilt);
    } else {
      frame = 0;
    }
  }

  function startListening() {
    if (listening) return;
    window.addEventListener("deviceorientation", onOrientation, { passive: true });
    listening = true;
    if (permissionButton) {
      permissionButton.hidden = true;
      permissionButton.setAttribute("aria-pressed", "true");
    }
  }

  function stopListening() {
    if (listening) window.removeEventListener("deviceorientation", onOrientation);
    listening = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    targetX = targetY = currentX = currentY = 0;
    app.style.setProperty("--ambient-tilt-x", "0px");
    app.style.setProperty("--ambient-tilt-y", "0px");
    if (permissionButton) permissionButton.setAttribute("aria-pressed", "false");
  }

  function syncQuality() {
    if (document.documentElement.dataset.graphicsQuality === "eco") {
      stopListening();
      if (permissionButton) permissionButton.hidden = true;
      return;
    }
    if (needsPermission && !hasPermission) {
      if (permissionButton) permissionButton.hidden = false;
      return;
    }
    startListening();
  }

  if (needsPermission) {
    permissionButton?.addEventListener("click", async () => {
      try {
        if (await DeviceOrientationEvent.requestPermission() === "granted") {
          hasPermission = true;
          startListening();
        }
      } catch {
        // The autonomous particle animation remains active if the sensor is unavailable.
      }
    });
  }
  window.addEventListener("graphicsqualitychange", syncQuality);
  syncQuality();
})();
