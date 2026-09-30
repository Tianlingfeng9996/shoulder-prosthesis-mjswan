# Shoulder Prosthesis Control Prototype

**Live demo:** https://tianlingfeng9996.github.io/shoulder-prosthesis-mjswan/

The first visit downloads the browser MuJoCo runtime and can take about a minute.

An interactive four-degree-of-freedom shoulder-prosthesis control prototype powered by
MuJoCo and the Mjswan browser engine.

The on-screen UI defaults to Japanese. A **日本語 / 中文** toggle in the header switches to Chinese and remembers the choice in this browser.

The public web version supports:

- Japanese and Chinese interface (日本語 by default);
- J1/J2 control modes;
- keyboard and touch controls;
- position hold when input is released;
- joint limits and configurable speeds;
- three reach targets with dwell detection;
- local CSV export of trial data.

> This is an equivalent kinematic prototype. Its geometry, axes, limits and inertial
> properties are temporary engineering assumptions and are not a verified conversion of
> the original Fusion assembly.

## Controls

| Mode | W | S | A | D |
|---|---|---|---|---|
| J1 | Shoulder flexion | Shoulder extension | Shoulder abduction | Shoulder adduction |
| J2 | Forearm forward | Forearm backward | Hand open | Hand close |

`Space` switches modes and `R` resets the simulation.

The web app pins `mjswan` 0.10.2. Its policy-oriented loop clears actuator controls
when no policy is loaded, so this prototype deliberately pauses that loop and advances
MuJoCo with a fixed 2 ms step through the pinned runtime API. Revalidate this adapter
before upgrading Mjswan.

## Local development

```bash
cd web
pnpm install
pnpm dev
```

The desktop Python/MuJoCo baseline remains under [`prototype/`](prototype/).
