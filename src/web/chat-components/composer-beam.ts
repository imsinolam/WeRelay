// Adapted from Libraries.dev BorderBeam md/colorful, inspected 2026-09-07.
// Source: https://libraries.dev/assets/index.es-G7N1mIpx.js
// Reference demo: size="md", colorVariant="colorful", theme="dark".
// Preserve upstream defaults; only the radius (28px) follows our composer.
// Light mode uses upstream md/light, not a brighter custom glow.
export const COMPOSER_BEAM_CSS = String.raw`
/*
MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

@property --beam-angle-composer {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: true;
}

@property --beam-opacity-composer {
  syntax: "<number>";
  initial-value: 0;
  inherits: true;
}

[data-beam="composer"] {
  position: relative;
  border-radius: 28px;
  overflow: hidden;
}

[data-beam="composer"][data-active] {
  animation:
    beam-spin-composer 1.96s linear infinite,
    beam-fade-in-composer 0.6s ease forwards;
}

[data-beam="composer"][data-fading] {
  animation:
    beam-spin-composer 1.96s linear infinite,
    beam-fade-out-composer 0.5s ease forwards;
}

[data-beam="composer"][data-active]::after,
[data-beam="composer"][data-fading]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 27px;
  padding: 1px;
  clip-path: inset(0 round 28px);
  background: conic-gradient(
        from var(--beam-angle-composer),
        transparent 0%, transparent 54%,
        rgba(0, 0, 0, 0.08) 57%,
        rgba(0, 0, 0, 0.2) 60%,
        rgba(0, 0, 0, 0.4) 63%,
        rgba(0, 0, 0, 0.55) 66%,
        rgba(0, 0, 0, 0.4) 69%,
        rgba(0, 0, 0, 0.2) 72%,
        rgba(0, 0, 0, 0.08) 75%,
        transparent 78%, transparent 100%
      ),radial-gradient(ellipse 70px 40px at 33% -7.4%, rgb(255, 50, 100), transparent),
    radial-gradient(ellipse 60px 35px at 12% -5%, rgb(40, 140, 255), transparent),
    radial-gradient(ellipse 40px 70px at 2.1% 68.3%, rgb(50, 200, 80), transparent),
    radial-gradient(ellipse 20px 35px at 2.1% 68.3%, rgb(30, 185, 170), transparent),
    radial-gradient(ellipse 180px 32px at 74.4% 100%, rgb(100, 70, 255), transparent),
    radial-gradient(ellipse 85px 26px at 55% 100%, rgb(40, 140, 255), transparent),
    radial-gradient(ellipse 74px 32px at 93.9% 0%, rgb(255, 120, 40), transparent),
    radial-gradient(ellipse 26px 42px at 100% 27.1%, rgb(240, 50, 180), transparent),
    radial-gradient(ellipse 52px 48px at 100% 27.1%, rgb(180, 40, 240), transparent);
  -webkit-mask:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: source-in, xor;
  mask:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: intersect, exclude;
  pointer-events: none;
  z-index: 2;
  opacity: calc(var(--beam-opacity-composer) * 0.12 * var(--beam-stroke-opacity, 1) * var(--beam-strength, 1));
  animation: beam-hue-shift-composer 12s ease-in-out infinite;
}

[data-beam="composer"][data-active]::before,
[data-beam="composer"][data-fading]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 28px;
  background: radial-gradient(ellipse 63px 36px at 33% -7.4%, rgba(255, 50, 100, 0.45), transparent),
    radial-gradient(ellipse 54px 32px at 12% -5%, rgba(40, 140, 255, 0.45), transparent),
    radial-gradient(ellipse 36px 63px at 2.1% 68.3%, rgba(50, 200, 80, 0.45), transparent),
    radial-gradient(ellipse 18px 32px at 2.1% 68.3%, rgba(30, 185, 170, 0.45), transparent),
    radial-gradient(ellipse 162px 29px at 74.4% 100%, rgba(100, 70, 255, 0.45), transparent),
    radial-gradient(ellipse 77px 23px at 55% 100%, rgba(40, 140, 255, 0.45), transparent),
    radial-gradient(ellipse 67px 29px at 93.9% 0%, rgba(255, 120, 40, 0.45), transparent),
    radial-gradient(ellipse 23px 38px at 100% 27.1%, rgba(240, 50, 180, 0.45), transparent),
    radial-gradient(ellipse 47px 43px at 100% 27.1%, rgba(180, 40, 240, 0.45), transparent);
  box-shadow: inset 0 0 9px 1px rgba(0, 0, 0, 0.14);
  -webkit-mask-image:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
    linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
  -webkit-mask-composite: source-in, source-over;
  mask-image:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
    linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
  mask-composite: intersect, add;
  pointer-events: none;
  z-index: 1;
  opacity: calc(var(--beam-opacity-composer) * 0.26 * var(--beam-inner-opacity, 1) * var(--beam-strength, 1));
  clip-path: inset(0 round 28px);
  animation: beam-hue-shift-composer 12s ease-in-out infinite;
}

[data-beam="composer"] [data-beam-bloom] {
  display: none;
  position: absolute;
  inset: 0;
  border-radius: 27px;
  clip-path: inset(0 round 28px);
  background: conic-gradient(
        from var(--beam-angle-composer),
        transparent 0%, transparent 58%,
        rgba(0, 0, 0, 0.02) 62%,
        rgba(0, 0, 0, 0.08) 65%,
        rgba(0, 0, 0, 0.2) 67%,
        rgba(0, 0, 0, 0.4) 69%,
        rgba(0, 0, 0, 0.6) 70%,
        rgba(0, 0, 0, 0.6) 70.5%,
        rgba(0, 0, 0, 0.4) 71.5%,
        rgba(0, 0, 0, 0.2) 73%,
        rgba(0, 0, 0, 0.08) 75%,
        rgba(0, 0, 0, 0.02) 78%,
        transparent 82%
      );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  padding: 1px;
  filter: blur(8px) brightness(1.30) saturate(1.50);
  pointer-events: none;
  z-index: 3;
  opacity: 0;
}

[data-beam="composer"][data-active] [data-beam-bloom],
[data-beam="composer"][data-fading] [data-beam-bloom] {
  display: block;
  opacity: calc(var(--beam-opacity-composer) * 0.34 * var(--beam-bloom-opacity, 1) * var(--beam-strength, 1));
}

@keyframes beam-spin-composer {
  to { --beam-angle-composer: 360deg; }
}

@keyframes beam-fade-in-composer {
  to { --beam-opacity-composer: 1; }
}

@keyframes beam-fade-out-composer {
  from { --beam-opacity-composer: 1; }
  to { --beam-opacity-composer: 0; }
}

@keyframes beam-hue-shift-composer {
  0% { filter: hue-rotate(calc(var(--beam-hue-base, 0deg) - 30deg)) brightness(1.30) saturate(1.50); }
  50% { filter: hue-rotate(calc(var(--beam-hue-base, 0deg) + 30deg)) brightness(1.30) saturate(1.50); }
  100% { filter: hue-rotate(calc(var(--beam-hue-base, 0deg) - 30deg)) brightness(1.30) saturate(1.50); }
}

[data-beam="composer"][data-paused],
[data-beam="composer"][data-paused]::after,
[data-beam="composer"][data-paused]::before,
[data-beam="composer"][data-paused] [data-beam-bloom] {
  animation-play-state: paused !important;
}

@media (prefers-color-scheme: dark) {
[data-beam="composer"][data-active]::after,
[data-beam="composer"][data-fading]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 27px;
  padding: 1px;
  clip-path: inset(0 round 28px);
  background: conic-gradient(
        from var(--beam-angle-composer),
        transparent 0%, transparent 54%,
        rgba(255, 255, 255, 0.1) 57%,
        rgba(255, 255, 255, 0.3) 60%,
        rgba(255, 255, 255, 0.6) 63%,
        rgba(255, 255, 255, 0.75) 66%,
        rgba(255, 255, 255, 0.6) 69%,
        rgba(255, 255, 255, 0.3) 72%,
        rgba(255, 255, 255, 0.1) 75%,
        transparent 78%, transparent 100%
      ),radial-gradient(ellipse 70px 40px at 33% -7.4%, rgb(255, 50, 100), transparent),
    radial-gradient(ellipse 60px 35px at 12% -5%, rgb(40, 140, 255), transparent),
    radial-gradient(ellipse 40px 70px at 2.1% 68.3%, rgb(50, 200, 80), transparent),
    radial-gradient(ellipse 20px 35px at 2.1% 68.3%, rgb(30, 185, 170), transparent),
    radial-gradient(ellipse 180px 32px at 74.4% 100%, rgb(100, 70, 255), transparent),
    radial-gradient(ellipse 85px 26px at 55% 100%, rgb(40, 140, 255), transparent),
    radial-gradient(ellipse 74px 32px at 93.9% 0%, rgb(255, 120, 40), transparent),
    radial-gradient(ellipse 26px 42px at 100% 27.1%, rgb(240, 50, 180), transparent),
    radial-gradient(ellipse 52px 48px at 100% 27.1%, rgb(180, 40, 240), transparent);
  -webkit-mask:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: source-in, xor;
  mask:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: intersect, exclude;
  pointer-events: none;
  z-index: 2;
  opacity: calc(var(--beam-opacity-composer) * 0.26 * var(--beam-stroke-opacity, 1) * var(--beam-strength, 1));
  animation: beam-hue-shift-composer 12s ease-in-out infinite;
}

[data-beam="composer"][data-active]::before,
[data-beam="composer"][data-fading]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 28px;
  background: radial-gradient(ellipse 63px 36px at 33% -7.4%, rgba(255, 50, 100, 0.45), transparent),
    radial-gradient(ellipse 54px 32px at 12% -5%, rgba(40, 140, 255, 0.45), transparent),
    radial-gradient(ellipse 36px 63px at 2.1% 68.3%, rgba(50, 200, 80, 0.45), transparent),
    radial-gradient(ellipse 18px 32px at 2.1% 68.3%, rgba(30, 185, 170, 0.45), transparent),
    radial-gradient(ellipse 162px 29px at 74.4% 100%, rgba(100, 70, 255, 0.45), transparent),
    radial-gradient(ellipse 77px 23px at 55% 100%, rgba(40, 140, 255, 0.45), transparent),
    radial-gradient(ellipse 67px 29px at 93.9% 0%, rgba(255, 120, 40, 0.45), transparent),
    radial-gradient(ellipse 23px 38px at 100% 27.1%, rgba(240, 50, 180, 0.45), transparent),
    radial-gradient(ellipse 47px 43px at 100% 27.1%, rgba(180, 40, 240, 0.45), transparent);
  box-shadow: inset 0 0 9px 1px rgba(255, 255, 255, 0.27);
  -webkit-mask-image:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
    linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
  -webkit-mask-composite: source-in, source-over;
  mask-image:
    conic-gradient(
      from var(--beam-angle-composer),
      transparent 0%, transparent 30%,
      rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
      white 52%, white 80%,
      rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
      transparent 95%, transparent 100%
    ),
    linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
    linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
  mask-composite: intersect, add;
  pointer-events: none;
  z-index: 1;
  opacity: calc(var(--beam-opacity-composer) * 0.42 * var(--beam-inner-opacity, 1) * var(--beam-strength, 1));
  clip-path: inset(0 round 28px);
  animation: beam-hue-shift-composer 12s ease-in-out infinite;
}

[data-beam="composer"] [data-beam-bloom] {
  display: none;
  position: absolute;
  inset: 0;
  border-radius: 27px;
  clip-path: inset(0 round 28px);
  background: conic-gradient(
        from var(--beam-angle-composer),
        transparent 0%, transparent 58%,
        rgba(255, 255, 255, 0.03) 62%,
        rgba(255, 255, 255, 0.08) 65%,
        rgba(255, 255, 255, 0.2) 67%,
        rgba(255, 255, 255, 0.45) 69%,
        rgba(255, 255, 255, 0.85) 70%,
        rgba(255, 255, 255, 0.85) 70.5%,
        rgba(255, 255, 255, 0.45) 71.5%,
        rgba(255, 255, 255, 0.2) 73%,
        rgba(255, 255, 255, 0.08) 75%,
        rgba(255, 255, 255, 0.03) 78%,
        transparent 82%
      );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  padding: 1px;
  filter: blur(8px) brightness(1.30) saturate(1.20);
  pointer-events: none;
  z-index: 3;
  opacity: 0;
}

[data-beam="composer"][data-active] [data-beam-bloom],
[data-beam="composer"][data-fading] [data-beam-bloom] {
  display: block;
  opacity: calc(var(--beam-opacity-composer) * 0.24 * var(--beam-bloom-opacity, 1) * var(--beam-strength, 1));
}

@keyframes beam-hue-shift-composer {
  0% { filter: hue-rotate(calc(var(--beam-hue-base, 0deg) - 30deg)) brightness(1.30) saturate(1.20); }
  50% { filter: hue-rotate(calc(var(--beam-hue-base, 0deg) + 30deg)) brightness(1.30) saturate(1.20); }
  100% { filter: hue-rotate(calc(var(--beam-hue-base, 0deg) - 30deg)) brightness(1.30) saturate(1.20); }
}
}
/* Keep the reference's clipped decoration separate from the interactive form:
   clipping the form itself would also clip model/permission popovers. */
.composer > .composer-beam {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  [data-beam="composer"][data-active],
  [data-beam="composer"][data-active]::before,
  [data-beam="composer"][data-active]::after {
    animation: none;
    --beam-angle-composer: 68deg;
    --beam-opacity-composer: 1;
  }
}
`;
