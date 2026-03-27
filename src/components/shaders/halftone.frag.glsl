#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uColorAccent;
uniform vec3 uColorBackground;
uniform float uDotScale;
uniform float uFadeIn; // 0..1, reveals dots from bottom upward

// ============================================================================
// Hash / noise helpers
// ============================================================================

float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Smooth 2D value noise
float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Hexagon signed distance field (pointy-top orientation).
// Returns distance from center of a regular hexagon, normalised so that
// the edge is at distance 1.0 when the input is in -1..1 range.
float hexDist(vec2 p) {
    p = abs(p);
    // Pointy-top: angled edges use (sin30, cos30) and the flat cap is on x
    return max(dot(p, vec2(0.5, 0.866025)), p.x);
}

// Fractal Brownian Motion — layered noise for rich fire turbulence
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
        value += amplitude * valueNoise(p);
        p *= 2.1;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / uResolution.y;

    // ========================================================================
    // Dot grid (clean halftone lattice)
    // ========================================================================

    float gridSize = uDotScale;
    vec2 cell = vec2(gridSize * aspect, gridSize);
    vec2 gridPos = uv * cell;

    // Odd-row offset: shift every other row by half a cell width
    // to create a honeycomb / brick stagger pattern.
    float row = floor(gridPos.y);
    float oddRow = mod(row, 2.0);
    gridPos.x += oddRow * 0.5;

    vec2 cellIndex = floor(gridPos);
    vec2 cellUv = fract(gridPos);

    // Per-cell random values
    float rPhase    = hash(cellIndex);
    float rPhase2   = hash(cellIndex + vec2(73.1, 19.7));
    float rTemp     = hash(cellIndex + vec2(41.3, 89.2));
    float rSize     = hash(cellIndex + vec2(17.9, 53.4));

    // Hexagon distance from cell center (normalised to 0..1 at edge)
    vec2 hexP = (cellUv - vec2(0.5)) * 2.0;
    float dist = hexDist(hexP);

    // ========================================================================
    // Flame glow field (bottom-up warmth — the primary shape)
    // ========================================================================

    // Vertical cutoff: effect lives in the bottom 2/3 of the screen.
    // smoothstep provides the base ease, then pow() adds aggressive falloff
    // so intensity drops quickly as it moves upward.
    // (uv.y = 0.0 is bottom, 1.0 is top)
    float verticalCutoff = pow(smoothstep(0.67, 0.15, uv.y), 2.5);

    float baseGlow = pow(1.0 - uv.y, 2.2) * 0.95;
    float centerFalloff = 1.0 - pow(abs(uv.x - 0.5) * 2.0, 2.5) * 0.5;
    baseGlow *= centerFalloff * verticalCutoff;

    // Background luminance — used later for compositing.
    float bgLuma = dot(uColorBackground, vec3(0.2126, 0.7152, 0.0722));

    // ========================================================================
    // Flickering flame animation (primary movement)
    // ========================================================================

    // Fire turbulence: FBM noise that rises upward over time.
    // The y-offset moves with time, creating upward-flowing fire shapes.
    // Multiple scales give both broad swells and fine crackle.
    vec2 fireUv = uv * vec2(3.0, 4.0);
    float fireLarge  = fbm(fireUv + vec2(0.0, -uTime * 0.4));
    float fireMedium = fbm(fireUv * 2.3 + vec2(1.7, -uTime * 0.7));
    float fireDetail = fbm(fireUv * 5.0 + vec2(-0.5, -uTime * 1.1));

    // Combine: broad shapes dominate, detail adds crackle
    float fireTurbulence = fireLarge * 0.5 + fireMedium * 0.3 + fireDetail * 0.2;

    // Modulate the flame glow with turbulence — creates organic pulsing.
    // High contrast: some dots nearly vanish while neighbours flare up,
    // so the fire pattern dominates over the grid regularity.
    float flameModulation = mix(0.0, 0.75, smoothstep(0.0, 0.35, baseGlow));
    float animatedGlow = baseGlow * (1.0 - flameModulation + flameModulation * fireTurbulence * 2.4);

    // ========================================================================
    // Per-dot flickering (ember sparkle)
    // ========================================================================

    // Each dot has its own flicker rhythm — rising phase so lower dots
    // lead and the flicker "travels" upward like heat shimmer.
    float risingPhase = uTime * 1.4 - uv.y * 3.5;

    float flicker = sin(risingPhase + rPhase * 6.283) * 0.30
                  + sin(risingPhase * 1.7 + rPhase2 * 6.283) * 0.25
                  + sin(uTime * 0.6 + (rPhase + rPhase2) * 3.14) * 0.15;
    flicker = clamp(flicker * 0.5 + 0.5, 0.0, 1.0);

    // Flicker is strongest in the flame region, subtle elsewhere
    float flickerStrength = mix(0.15, 0.5, smoothstep(0.0, 0.3, baseGlow));
    animatedGlow *= mix(1.0 - flickerStrength, 1.0, flicker);

    // ========================================================================
    // Subtle digital rain accent (ghost of the Matrix — barely perceptible)
    // ========================================================================

    // Per-column properties — very gentle vertical coherence
    float colSeed = cellIndex.x;
    float colSpeed = mix(0.3, 0.8, hash(vec2(colSeed, 0.0)));
    float colPhase = hash(vec2(colSeed, 7.77)) * 50.0;

    // Soft sine wave traveling down each column — no hard leading edge
    float columnWave = sin(cellIndex.y * 0.4 - uTime * colSpeed + colPhase) * 0.5 + 0.5;
    // Second layer at different frequency for more organic feel
    float columnWave2 = sin(cellIndex.y * 0.25 - uTime * colSpeed * 0.6 + colPhase * 1.3) * 0.5 + 0.5;
    float digitalAccent = columnWave * columnWave2;

    // Mix in very subtly — just enough to add a faint vertical shimmer
    // Only visible within the flame region
    float digitalStrength = smoothstep(0.0, 0.2, baseGlow) * 0.12;
    animatedGlow += digitalAccent * digitalStrength;

    animatedGlow = clamp(animatedGlow, 0.0, 1.0);

    // ========================================================================
    // Dot radius
    // ========================================================================

    // Wider size range: quiet areas have tiny hexagons, hot areas swell large.
    // The big size swing makes you see the flame shape, not the grid.
    float baseDotRadius = 0.08;
    float sizeVariance = mix(0.85, 1.15, rSize);
    float dotRadius = (baseDotRadius + animatedGlow * 0.58) * sizeVariance;

    // Hollow hexagon: outer and inner edges with a stroke between them
    float strokeWidth = 0.15;
    float innerRadius = dotRadius - strokeWidth;

    float edgeWidth = fwidth(dist);
    float outerHex = smoothstep(dotRadius - edgeWidth, dotRadius + edgeWidth, dist);
    float innerHex = smoothstep(innerRadius - edgeWidth, innerRadius + edgeWidth, dist);
    float dotMask = innerHex * (1.0 - outerHex);

    // ========================================================================
    // Color: warm flame palette (same in both light and dark mode)
    // ========================================================================

    vec3 hot  = uColorAccent * vec3(1.3, 1.1, 0.7);   // push toward yellow
    vec3 warm = uColorAccent;
    vec3 cool = uColorAccent * vec3(0.7, 0.4, 0.35);   // deep ember red

    // Temperature driven by glow intensity + per-dot randomness
    float temp = rTemp * 0.4 + animatedGlow * 0.6;
    vec3 dotHue = temp < 0.5
        ? mix(cool, warm, temp * 2.0)
        : mix(warm, hot, (temp - 0.5) * 2.0);

    // Outside glow: very subtle background tint
    vec3 subtleDotColor = mix(uColorBackground, uColorAccent, 0.08);
    vec3 finalDotColor = mix(subtleDotColor, dotHue, animatedGlow);

    // ========================================================================
    // Fade-in reveal (bottom to top sweep)
    // ========================================================================

    float revealLine = uFadeIn * 1.4;
    float reveal = smoothstep(0.0, 0.3, revealLine - uv.y);

    // ========================================================================
    // Composite
    // ========================================================================

    vec3 color = mix(uColorBackground, finalDotColor, dotMask * reveal);
    fragColor = vec4(color, 1.0);
}
