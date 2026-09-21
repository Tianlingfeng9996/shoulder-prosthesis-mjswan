#!/usr/bin/env python3
"""Headless compile-and-step test for the prototype MJCF."""

from __future__ import annotations

import math
from pathlib import Path

import mujoco
import numpy as np


ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "model" / "shoulder_prosthesis_simplified.xml"

EXPECTED_JOINTS = (
    "shoulder_flexion",
    "shoulder_abduction",
    "forearm_pitch",
    "hand_aperture_left",
    "hand_aperture_right",
)
EXPECTED_ACTUATORS = (
    "shoulder_flexion_servo",
    "shoulder_abduction_servo",
    "forearm_pitch_servo",
    "hand_aperture_servo",
)


def main() -> None:
    model = mujoco.MjModel.from_xml_path(str(MODEL_PATH))
    data = mujoco.MjData(model)
    for name in EXPECTED_JOINTS:
        assert mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name) >= 0, name
    for name in EXPECTED_ACTUATORS:
        assert mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, name) >= 0, name

    assert model.nu == 4, f"expected 4 control signals, got {model.nu}"
    key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "home")
    mujoco.mj_resetDataKeyframe(model, data, key_id)

    # Exercise every logical DOF while remaining inside the temporary limits.
    data.ctrl[:] = [math.radians(35), math.radians(30), math.radians(75), 0.025]
    for _ in range(1500):
        mujoco.mj_step(model, data)

    assert np.isfinite(data.qpos).all()
    assert np.isfinite(data.qvel).all()
    assert abs(data.time - 3.0) < 1e-9, f"simulation reset after instability at t={data.time}"
    warning_count = sum(data.warning[index].number for index in range(mujoco.mjtWarning.mjNWARNING.value))
    assert warning_count == 0, f"MuJoCo emitted {warning_count} warning(s)"
    site_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, "end_effector")
    assert np.isfinite(data.site_xpos[site_id]).all()

    right_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "hand_aperture_right")
    left_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "hand_aperture_left")
    right = float(data.qpos[model.jnt_qposadr[right_id]])
    left = float(data.qpos[model.jnt_qposadr[left_id]])
    assert abs(right - left) < 5e-4, (left, right)

    print("MJCF compile/step test: PASS")
    print(f"MuJoCo version: {mujoco.__version__}")
    print(f"nq={model.nq}, nv={model.nv}, nu={model.nu}, neq={model.neq}")
    print("final logical qpos:", np.array2string(data.qpos[[0, 1, 2, 3]], precision=5))
    print("end_effector xyz:", np.array2string(data.site_xpos[site_id], precision=5))


if __name__ == "__main__":
    main()
