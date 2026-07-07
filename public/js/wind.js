/**
 * wind.js — White particle animation matching Windy.com style
 *
 * Small white dashes that flow through the wind field. Dash speed encodes
 * wind speed (scaled to the map zoom) with very short, fast-fading trails.
 */

export class WindRenderer {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.grid = null;
    this.particles = [];
    this.running = false;
    this.animFrame = null;
    this.visible = true;

    // ── Tuning to match Windy screenshots ──
    this.particleDensity = 0.45;  // per 1000 screen px
    this.maxAge = 40;             // short-lived
    this.speed = 0.7;             // reference px/frame at zoom 5, 10 m/s wind
    // Perceptual zoom-speed exponent: 0 = constant screen speed (feels too
    // fast zoomed out, too slow zoomed in), 1/3 = the old curve (felt too
    // fast zoomed in). Tunable live via window.__flowTune(exp) or ?flowexp=.
    this.speedZoomExp = 0.18;
    this.fadeOpacity = 0.86;      // fast fade → very short tails
    this.lineWidth = 1.0;
    this.color = 'rgba(255, 255, 255, 0.65)';

    this._resizeBound = () => this._resize();
    window.addEventListener('resize', this._resizeBound);
    this._resize();

    this.map.on('zoom', () => {
      this._zooming = true;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    });

    this.map.on('zoomend', () => {
      this._zooming = false;
      this._initParticles();
    });

    this.map.on('moveend', () => {
      this._cullOffscreen();
    });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._initParticles();
  }

  _initParticles() {
    const zoom = this.map.getZoom();
    const zoomScale = Math.pow(2, Math.max(0, 5 - zoom));
    const count = Math.min(
      Math.floor((window.innerWidth * window.innerHeight / 1000) * this.particleDensity * zoomScale),
      12000
    );
    this.particles = [];
    for (let i = 0; i < count; i++) {
      this.particles.push(this._randomParticle());
    }
  }

  _cullOffscreen() {
    const bounds = this.map.getBounds();
    const w = bounds.getWest(), e = bounds.getEast();
    const s = bounds.getSouth(), n = bounds.getNorth();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.lng < w || p.lng > e || p.lat < s || p.lat > n) {
        this.particles[i] = this._randomParticle();
      }
    }
  }

  _randomParticle() {
    const bounds = this.map.getBounds();
    return {
      lng: bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest()),
      lat: bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth()),
      age: Math.floor(Math.random() * this.maxAge),
    };
  }

  setGrid(grid) {
    this.grid = grid;
    // Keep existing particles — their lng/lat positions are still valid, only
    // the velocity field changed. Re-seeding 12k particles on every timeline
    // scrub tick caused visible flashes and GC churn.
    if (this.particles.length === 0) this._initParticles();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._animate();
  }

  stop() {
    this.running = false;
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  setVisible(v) {
    this.visible = v;
    this.canvas.style.display = v ? '' : 'none';
    if (v && this.running && !this.animFrame) this._animate();
  }

  _animate() {
    if (!this.running || !this.visible) {
      this.animFrame = null;
      return;
    }

    if (this._zooming) {
      this.animFrame = requestAnimationFrame(() => this._animate());
      return;
    }

    const ctx = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Fast-fade existing trails
    ctx.globalCompositeOperation = 'destination-in';
    ctx.globalAlpha = this.fadeOpacity;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';

    if (!this.grid) {
      this.animFrame = requestAnimationFrame(() => this._animate());
      return;
    }

    // Line width keeps a gentle cosmetic curve with zoom. Speed follows a
    // soft perceptual curve (see speedZoomExp above), clamped to ±few
    // levels so the extremes stay usable.
    const zoom = this.map.getZoom();
    const zoomScale = Math.pow(2, (zoom - 5) / 3);
    const zd = Math.min(Math.max(zoom - 5, -3), 4);
    const speedZoom = Math.pow(2, zd * this.speedZoomExp);

    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth * zoomScale;
    ctx.lineCap = 'round';
    ctx.beginPath();

    const frameSpeed = this.speed * speedZoom;

    for (const p of this.particles) {
      const wind = this.grid.interpolate(p.lng, p.lat);
      if (!wind) {
        Object.assign(p, this._randomParticle());
        p.age = 0;
        continue;
      }

      const [u, v] = wind;
      const speed = Math.sqrt(u * u + v * v);

      // Skip calm areas
      if (speed < 0.3) {
        p.age++;
        if (p.age >= this.maxAge) {
          Object.assign(p, this._randomParticle());
          p.age = 0;
        }
        continue;
      }

      // Direction from u/v; step length encodes the actual wind speed
      // (10 m/s = reference) so gales visibly outrun light breezes.
      const nx = u / speed;
      const ny = v / speed;
      const step = frameSpeed * Math.max(0.15, Math.min(speed / 10, 2.2));

      const pt0 = this.map.project([p.lng, p.lat]);
      const px1 = pt0.x + nx * step;
      const py1 = pt0.y - ny * step;

      // Unproject back to geo
      const geo1 = this.map.unproject([px1, py1]);
      p.lng = geo1.lng;
      p.lat = geo1.lat;
      p.age++;

      // Draw dash
      ctx.moveTo(pt0.x, pt0.y);
      ctx.lineTo(px1, py1);

      // Reset if expired or off-screen
      if (
        p.age >= this.maxAge ||
        px1 < -20 || px1 > w + 20 ||
        py1 < -20 || py1 > h + 20
      ) {
        Object.assign(p, this._randomParticle());
        p.age = 0;
      }
    }

    ctx.stroke();
    this.animFrame = requestAnimationFrame(() => this._animate());
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._resizeBound);
  }
}
