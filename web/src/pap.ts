/** Pick-and-place trial. Geometry matches prototype/model/shoulder_prosthesis_simplified.xml. */

const DEG = Math.PI / 180;

export const CUBE_COUNT = 5;
export const CUBE_NAMES = ['pap_cube_1', 'pap_cube_2', 'pap_cube_3', 'pap_cube_4', 'pap_cube_5'] as const;
export const STAGE_JOINT = 'pap_stage_free';
export const LEFT_FINGER_GEOM = 'left_finger_geom';
export const RIGHT_FINGER_GEOM = 'right_finger_geom';
export const HAND_BODY = 'hand';
export const ZONE_A_GEOM = 'pap_zone_a';
export const ZONE_B_GEOM = 'pap_zone_b';

/** Home keyframe parks the stage and cubes here so the reach demo never touches them. */
export const PARK_Z = -8;

/** Cube centers on the zone-A pedestals, 1 mm above the stand. */
export const CUBE_SPAWN: readonly (readonly [number, number, number])[] = [
  [-0.24, 0.1, 0.299],
  [-0.24, 0.0, 0.299],
  [-0.24, -0.1, 0.299],
  [-0.14, 0.06, 0.299],
  [-0.14, -0.06, 0.299],
];

/** Hover in the gap between the mats, clear of every cube, hand open. */
export const PAP_HOME = [-25 * DEG, 0, 50 * DEG, 0.035] as const;

export const DEMO_CAMERA = {
  lookat: [0, 0, 0.66] as [number, number, number],
  distance: 1.7,
  azimuth: 135,
  elevation: -18,
};

/** Azimuth 270 puts zone A (-X) on the left of the screen and zone B (+X) on the right. */
export const PAP_CAMERA = {
  lookat: [0, 0.02, 0.42] as [number, number, number],
  distance: 1.2,
  azimuth: 270,
  elevation: -36,
};

export const INSIDE_SECONDS = 0.35;
export const OUTSIDE_SECONDS = 0.28;
/** Extra height above the mat center. Resting and pedestal cubes count; a raised carry does not. */
export const ZONE_HEIGHT = 0.1;

/**
 * Commanded aperture at or below this, with a fingertip near a cube, attaches it.
 * The pads do not physically pinch; closing next to a cube is the grasp.
 */
export const GRASP_CLOSE = 0.03;
/**
 * Commanded aperture at or above this releases the cube.
 * Higher than GRASP_CLOSE so a half-closed hand does not drop the cube on the next frame.
 */
export const GRASP_RELEASE = 0.034;
/** Cube center must be this close to a fingertip. The nearest cube wins, so a rough aim is enough. */
export const FINGER_REACH = 0.09;

export type AppMode = 'demo' | 'pap';

export type Zone = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type Latch = {
  insideFor: number;
  outsideFor: number;
  placed: boolean;
};

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export function emptyLatches(): Latch[] {
  return Array.from({ length: CUBE_COUNT }, () => ({ insideFor: 0, outsideFor: 0, placed: false }));
}

export function zoneFromBox(position: readonly number[], size: readonly number[], height: number): Zone {
  return {
    minX: position[0] - size[0],
    maxX: position[0] + size[0],
    minY: position[1] - size[1],
    maxY: position[1] + size[1],
    minZ: position[2] - size[2],
    maxZ: position[2] + height,
  };
}

export function containsPoint(zone: Zone, x: number, y: number, z: number): boolean {
  return x >= zone.minX && x <= zone.maxX && y >= zone.minY && y <= zone.maxY && z >= zone.minZ && z <= zone.maxZ;
}

export function stepLatches(latches: readonly Latch[], inside: readonly boolean[], dt: number): void {
  for (let index = 0; index < latches.length; index += 1) {
    const latch = latches[index];
    if (inside[index]) {
      latch.insideFor += dt;
      latch.outsideFor = 0;
      if (latch.insideFor >= INSIDE_SECONDS) latch.placed = true;
    } else {
      latch.outsideFor += dt;
      latch.insideFor = 0;
      if (latch.outsideFor >= OUTSIDE_SECONDS) latch.placed = false;
    }
  }
}

export function placedCount(latches: readonly Latch[]): number {
  return latches.reduce((count, latch) => count + (latch.placed ? 1 : 0), 0);
}

export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Rotate a vector by a unit quaternion stored as w, x, y, z. */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function worldFromHand(handPos: Vec3, handQuat: Quat, local: Vec3): Vec3 {
  const rotated = rotateByQuat(handQuat, local);
  return [handPos[0] + rotated[0], handPos[1] + rotated[1], handPos[2] + rotated[2]];
}

export function handFromWorld(handPos: Vec3, handQuat: Quat, world: Vec3): Vec3 {
  const delta: Vec3 = [world[0] - handPos[0], world[1] - handPos[1], world[2] - handPos[2]];
  return rotateByQuat([handQuat[0], -handQuat[1], -handQuat[2], -handQuat[3]], delta);
}

/** Index of the cube closest to either fingertip, if it is inside the reach. */
export function nearestFingerCube(fingers: readonly Vec3[], cubes: readonly Vec3[]): number {
  let best = -1;
  let bestDistance = FINGER_REACH;
  for (let index = 0; index < cubes.length; index += 1) {
    for (const finger of fingers) {
      const distance = Math.hypot(
        finger[0] - cubes[index][0],
        finger[1] - cubes[index][1],
        finger[2] - cubes[index][2],
      );
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** A point in the gap between the pads, nearest the cube, so the snap stays between the fingers. */
export function holdPoint(left: Vec3, right: Vec3, cube: Vec3): Vec3 {
  const axis: Vec3 = [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
  const span = Math.hypot(axis[0], axis[1], axis[2]);
  if (span < 1e-4) return [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2];
  const rel: Vec3 = [cube[0] - right[0], cube[1] - right[1], cube[2] - right[2]];
  const t = Math.min(0.8, Math.max(0.2, (rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2]) / (span * span)));
  return [right[0] + axis[0] * t, right[1] + axis[1] * t, right[2] + axis[2] * t];
}
