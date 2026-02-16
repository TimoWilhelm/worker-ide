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

// Per-cell hash — gives each dot unique properties
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / uResolution.y;

    // --- Dot grid ---
    float gridSize = uDotScale;
    vec2 cell = vec2(gridSize * aspect, gridSize);
    vec2 cellIndex = floor(uv * cell);
    vec2 cellUv = fract(uv * cell);

    float dist = length(cellUv - vec2(0.5)) * 2.0;

    // --- Per-dot random properties (4 independent hashes) ---
    float rPhase    = hash(cellIndex);                // flicker timing
    float rPhase2   = hash(cellIndex + vec2(73.1, 19.7));  // second flicker layer
    float rTemp     = hash(cellIndex + vec2(41.3, 89.2));  // color temperature
    float rSize     = hash(cellIndex + vec2(17.9, 53.4));  // size variance

    // --- Glow field: defines the flame region ---
    float baseGlow = pow(1.0 - uv.y, 2.5) * 0.85;
    float centerFalloff = 1.0 - pow(abs(uv.x - 0.5) * 2.0, 2.5) * 0.5;
    baseGlow *= centerFalloff;

    // Reduce glow intensity on light backgrounds to keep dots subtle
    float bgLuma = dot(uColorBackground, vec3(0.2126, 0.7152, 0.0722));
    float themeScale = mix(1.0, 0.3, bgLuma);
    baseGlow *= themeScale;

    // --- Per-dot flickering with upward flow ---
    // Time phase incorporates uv.y so the flicker "rises" —
    // dots lower on screen lead, higher dots follow with a delay.
    float risingPhase = uTime * 1.6 - uv.y * 4.0;

    float flicker = sin(risingPhase + rPhase * 6.283) * 0.30
                  + sin(risingPhase * 1.7 + rPhase2 * 6.283) * 0.25
                  + sin(uTime * 0.7 + (rPhase + rPhase2) * 3.14) * 0.20;
    flicker = clamp(flicker * 0.5 + 0.5, 0.0, 1.0); // normalize to 0..1

    // Flicker modulates the glow — dots pulse between dim and bright
    float animatedGlow = baseGlow * mix(0.3, 1.0, flicker);

    // --- Dot radius ---
    // Base: tiny dot. In glow region, dots grow. Per-dot size variance.
    float baseDotRadius = 0.125;
    float sizeVariance = mix(0.9, 1.1, rSize);
    float dotRadius = (baseDotRadius + animatedGlow * 0.4) * sizeVariance;

    // Antialiased circle (resolution-agnostic via fwidth)
    float edgeWidth = fwidth(dist);
    float dotMask = 1.0 - smoothstep(dotRadius - edgeWidth, dotRadius + edgeWidth, dist);

    // --- Color variation per dot ---
    // Temperature shifts each dot's hue within the warm palette:
    //   hot (high temp)  → bright orange-yellow (accent * 1.4)
    //   warm (mid temp)  → standard accent
    //   cool (low temp)  → deep muted red-brown (accent * 0.6 + slight shift)
    vec3 hotColor = uColorAccent * vec3(1.3, 1.1, 0.7);   // push toward yellow
    vec3 warmColor = uColorAccent;
    vec3 coolColor = uColorAccent * vec3(0.7, 0.4, 0.35);  // deep ember red

    // Each dot picks a base temperature; glow intensity pushes it hotter
    float temp = rTemp * 0.4 + animatedGlow * 0.6;
    // Remap: 0..0.5 = cool→warm, 0.5..1.0 = warm→hot
    vec3 dotHue = temp < 0.5
        ? mix(coolColor, warmColor, temp * 2.0)
        : mix(warmColor, hotColor, (temp - 0.5) * 2.0);

    // Outside the glow, dots are a very subtle background tint
    vec3 subtleDotColor = mix(uColorBackground, uColorAccent, 0.08);
    vec3 finalDotColor = mix(subtleDotColor, dotHue, animatedGlow);

    // --- Fade-in from bottom ---
    // uFadeIn goes 0→1 over ~2s. The reveal line sweeps upward:
    // dots at the very bottom (uv.y=1.0 in GL, but we flipped: 1-uv.y=bottom)
    // appear first, top of screen appears last.
    // Using smoothstep for a soft edge rather than a hard wipe.
    float revealLine = uFadeIn * 1.4; // overshoot so the top fully reveals
    float reveal = smoothstep(0.0, 0.3, revealLine - uv.y);

    // --- Composite ---
    vec3 color = mix(uColorBackground, finalDotColor, dotMask * reveal);

    fragColor = vec4(color, 1.0);
}
