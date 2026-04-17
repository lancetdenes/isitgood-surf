/**
 * swell.js — Particle animation for swell wave propagation
 *
 * Dashes flow in the swell direction (direction waves are traveling TO).
 * Slower and more spaced out than wind particles, with a subtle blue tint
 * to distinguish from the white wind dashes.
 */

export class SwellRenderer {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.grid = null;
    this.particles = [];
    this.running = false;
    this.animFrame = null;
    this.visible = false;
    this.canvas.style.display = 'none';

    // ── Tuning ──
    this.particleDensity = 0.55;   // base density (before swell-height boost)
    this.maxAge = 30;              // shorter life → less travel distance
    this.baseSpeed = 0.2;          // calm-swell speed (px/frame)
    this.maxSpeed = 0.55;          // big-swell speed
    this.dashLen = 6;              // px length of each dash
    this.fadeOpacity = 0.85;       // faster fade
    this.lineWidth = 1.4;
    this.color = 'rgba(180, 220, 255, 0.6)';

    this._resizeBound = () => this._resize();
    window.addEventListener('resize', this._resizeBound);
    this._resize();

    // During zoom: pause drawing to avoid ghost dashes at wrong positions
    this.map.on('zoom', () => {
      this._zooming = true;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    });

    // After zoom: redistribute particles in the new viewport
    this.map.on('zoomend', () => {
      this._zooming = false;
      this._initParticles();
    });

    // After pan: respawn any particles that drifted out of view
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
    // Scale particle count with zoom: more particles when zoomed out so
    // the visual density stays consistent across zoom levels.
    // At zoom 5 use the base density; each zoom level out doubles the area,
    // so we add particles to compensate.
    const zoom = this.map.getZoom();
    const zoomScale = Math.pow(2, Math.max(0, 5 - zoom));
    const count = Math.floor(
      (window.innerWidth * window.innerHeight / 1000) * this.particleDensity * zoomScale
    );
    // Cap to avoid perf issues at very low zoom
    const capped = Math.min(count, 12000);
    this.particles = [];
    for (let i = 0; i < capped; i++) {
      this.particles.push(this._randomParticle());
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

  /** Replace particles that have drifted outside the current viewport. */
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

  setGrid(grid) {
    this.grid = grid;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._initParticles();
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

    // Don't draw during active zoom — canvas is cleared, wait for zoomend
    if (this._zooming) {
      this.animFrame = requestAnimationFrame(() => this._animate());
      return;
    }

    const ctx = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Fade existing trails
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

    // Scale everything with zoom so visual appearance stays consistent.
    // At zoom 5 (reference level) all values are 1x.
    const zoom = this.map.getZoom();
    const zoomScale = Math.pow(2, (zoom - 5) / 3);  // gentle curve

    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth * zoomScale;
    ctx.lineCap = 'round';

    const halfDash = (this.dashLen * zoomScale) / 2;
    const speedScale = zoomScale;  // slower when zoomed out, faster when zoomed in

    for (const p of this.particles) {
      const vals = this.grid.interpolate(p.lng, p.lat);
      if (!vals) {
        Object.assign(p, this._randomParticle());
        p.age = 0;
        continue;
      }

      const height = vals[0];   // swell height (m)
      const dirFrom = vals[1];  // direction waves come FROM (degrees, meteorological)

      // Skip flat/land areas
      if (height < 0.1) {
        p.age++;
        if (p.age >= this.maxAge) {
          Object.assign(p, this._randomParticle());
          p.age = 0;
        }
        continue;
      }

      // Convert "from" direction to "toward" direction for particle motion.
      // Meteorological convention: 0° = from N, 90° = from E.
      const dirTo = (dirFrom + 180) % 360;
      const rad = dirTo * Math.PI / 180;

      // Unit direction in screen space
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);  // screen Y is inverted

      // Speed scales with swell height and zoom level
      const t = Math.min(height / 5, 1);
      const speed = (this.baseSpeed + t * (this.maxSpeed - this.baseSpeed)) * speedScale;

      // Advance particle position
      const pt0 = this.map.project([p.lng, p.lat]);
      const cx = pt0.x + dx * speed;
      const cy = pt0.y + dy * speed;

      const geo1 = this.map.unproject([cx, cy]);
      p.lng = geo1.lng;
      p.lat = geo1.lat;
      p.age++;

      // Draw a dash perpendicular to the travel direction (like a wave crest)
      ctx.beginPath();
      ctx.moveTo(cx - dy * halfDash, cy + dx * halfDash);
      ctx.lineTo(cx + dy * halfDash, cy - dx * halfDash);
      ctx.stroke();

      // Reset if expired or off-screen
      if (
        p.age >= this.maxAge ||
        cx < -20 || cx > w + 20 ||
        cy < -20 || cy > h + 20
      ) {
        Object.assign(p, this._randomParticle());
        p.age = 0;
      }
    }
    this.animFrame = requestAnimationFrame(() => this._animate());
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._resizeBound);
  }
}
