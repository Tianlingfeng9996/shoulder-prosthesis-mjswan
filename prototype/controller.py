#!/usr/bin/env python3
"""Keyboard controller for the simplified shoulder-prosthesis MuJoCo model."""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime
from pathlib import Path

import glfw
import mujoco


ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "model" / "shoulder_prosthesis_simplified.xml"
PARAMETER_PATH = ROOT / "parameters.json"
LOG_DIR = ROOT / "logs"

JOINT_NAMES = (
    "shoulder_flexion",
    "shoulder_abduction",
    "forearm_pitch",
    "hand_aperture_left",
)
ACTUATOR_NAMES = (
    "shoulder_flexion_servo",
    "shoulder_abduction_servo",
    "forearm_pitch_servo",
    "hand_aperture_servo",
)
MODE_LABELS = ("J1 肩屈伸 + 肩外展/内收", "J2 前臂前后 + 手开闭")


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


class PrototypeController:
    def __init__(self) -> None:
        with PARAMETER_PATH.open(encoding="utf-8") as handle:
            self.parameters = json.load(handle)

        self.model = mujoco.MjModel.from_xml_path(str(MODEL_PATH))
        self.data = mujoco.MjData(self.model)
        self.mode = 0
        self.pressed: set[int] = set()
        self.reset_requested = False

        self.joint_ids = [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name) for name in JOINT_NAMES]
        self.qpos_addresses = [int(self.model.jnt_qposadr[joint_id]) for joint_id in self.joint_ids]
        self.actuator_ids = [
            mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, name) for name in ACTUATOR_NAMES
        ]
        self.site_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SITE, "end_effector")
        self.home_key_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_KEY, "home")

        p = self.parameters["degrees_of_freedom"]
        self.lower = [
            math.radians(p["shoulder_flexion"]["minimum_deg"]),
            math.radians(p["shoulder_abduction"]["minimum_deg"]),
            math.radians(p["forearm_pitch"]["minimum_deg"]),
            p["hand_aperture"]["minimum_m"],
        ]
        self.upper = [
            math.radians(p["shoulder_flexion"]["maximum_deg"]),
            math.radians(p["shoulder_abduction"]["maximum_deg"]),
            math.radians(p["forearm_pitch"]["maximum_deg"]),
            p["hand_aperture"]["maximum_m"],
        ]
        self.speed = [
            math.radians(p["shoulder_flexion"]["speed_deg_s"]),
            math.radians(p["shoulder_abduction"]["speed_deg_s"]),
            math.radians(p["forearm_pitch"]["speed_deg_s"]),
            p["hand_aperture"]["speed_m_s"],
        ]
        self.targets = [0.0] * 4

        LOG_DIR.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = LOG_DIR / f"trial_{stamp}.csv"
        self.log_file = self.log_path.open("w", newline="", encoding="utf-8")
        self.log_writer = csv.writer(self.log_file)
        self.log_writer.writerow(
            [
                "sim_time_s",
                "mode",
                "vertical_input",
                "horizontal_input",
                "shoulder_flexion_deg",
                "shoulder_abduction_deg",
                "forearm_pitch_deg",
                "hand_aperture_left_m",
                "target_shoulder_flexion_deg",
                "target_shoulder_abduction_deg",
                "target_forearm_pitch_deg",
                "target_hand_aperture_left_m",
                "end_effector_x_m",
                "end_effector_y_m",
                "end_effector_z_m",
            ]
        )
        self.next_log_time = 0.0
        self.reset()

    def reset(self) -> None:
        mujoco.mj_resetDataKeyframe(self.model, self.data, self.home_key_id)
        self.targets = [float(self.data.qpos[address]) for address in self.qpos_addresses]
        self.apply_targets()
        mujoco.mj_forward(self.model, self.data)
        self.pressed.clear()
        self.reset_requested = False

    def axes(self) -> tuple[int, int]:
        vertical = int(glfw.KEY_W in self.pressed) - int(glfw.KEY_S in self.pressed)
        horizontal = int(glfw.KEY_A in self.pressed) - int(glfw.KEY_D in self.pressed)
        return vertical, horizontal

    def update_targets(self, dt: float) -> None:
        if self.reset_requested:
            self.reset()
            return

        vertical, horizontal = self.axes()
        if self.mode == 0:
            commands = ((0, vertical), (1, horizontal))
        else:
            commands = ((2, vertical), (3, horizontal))

        for target_index, direction in commands:
            self.targets[target_index] = clamp(
                self.targets[target_index] + direction * self.speed[target_index] * dt,
                self.lower[target_index],
                self.upper[target_index],
            )

    def apply_targets(self) -> None:
        for actuator_id, target in zip(self.actuator_ids, self.targets):
            self.data.ctrl[actuator_id] = target

    def step(self) -> None:
        dt = float(self.model.opt.timestep)
        self.update_targets(dt)
        self.apply_targets()
        mujoco.mj_step(self.model, self.data)
        if self.data.time + 1e-9 >= self.next_log_time:
            self.write_log_row()
            self.next_log_time += 0.02

    def write_log_row(self) -> None:
        vertical, horizontal = self.axes()
        q = [float(self.data.qpos[address]) for address in self.qpos_addresses]
        ee = self.data.site_xpos[self.site_id]
        self.log_writer.writerow(
            [
                f"{self.data.time:.4f}",
                "J1" if self.mode == 0 else "J2",
                vertical,
                horizontal,
                *(f"{math.degrees(q[i]):.5f}" for i in range(3)),
                f"{q[3]:.6f}",
                *(f"{math.degrees(self.targets[i]):.5f}" for i in range(3)),
                f"{self.targets[3]:.6f}",
                *(f"{float(value):.6f}" for value in ee),
            ]
        )

    def close(self) -> None:
        self.log_file.flush()
        self.log_file.close()


def run() -> None:
    controller = PrototypeController()
    if not glfw.init():
        controller.close()
        raise RuntimeError("GLFW 初始化失败；请在有桌面显示的本机终端运行。")

    window = glfw.create_window(1100, 760, "肩义手 MuJoCo 控制原型", None, None)
    if window is None:
        glfw.terminate()
        controller.close()
        raise RuntimeError("无法创建 MuJoCo 窗口。")
    glfw.make_context_current(window)
    glfw.swap_interval(1)

    camera = mujoco.MjvCamera()
    camera.lookat[:] = [0.0, 0.0, 0.65]
    camera.distance = 1.65
    camera.azimuth = 135
    camera.elevation = -18
    option = mujoco.MjvOption()
    scene = mujoco.MjvScene(controller.model, maxgeom=2000)
    context = mujoco.MjrContext(controller.model, mujoco.mjtFontScale.mjFONTSCALE_150.value)

    def on_key(_window, key, _scancode, action, _mods) -> None:
        if key in (glfw.KEY_W, glfw.KEY_A, glfw.KEY_S, glfw.KEY_D):
            if action in (glfw.PRESS, glfw.REPEAT):
                controller.pressed.add(key)
            elif action == glfw.RELEASE:
                controller.pressed.discard(key)
        elif key == glfw.KEY_SPACE and action == glfw.PRESS:
            controller.mode = 1 - controller.mode
            controller.pressed.clear()
        elif key == glfw.KEY_R and action == glfw.PRESS:
            controller.reset_requested = True
        elif key == glfw.KEY_ESCAPE and action == glfw.PRESS:
            glfw.set_window_should_close(window, True)

    def on_focus(_window, focused) -> None:
        if not focused:
            controller.pressed.clear()

    def on_scroll(_window, _xoffset, yoffset) -> None:
        camera.distance = clamp(camera.distance * (0.9 ** yoffset), 0.6, 4.0)

    glfw.set_key_callback(window, on_key)
    glfw.set_window_focus_callback(window, on_focus)
    glfw.set_scroll_callback(window, on_scroll)

    previous_wall_time = glfw.get_time()
    accumulator = 0.0
    last_title_update = 0.0
    dt = float(controller.model.opt.timestep)
    try:
        while not glfw.window_should_close(window):
            now = glfw.get_time()
            accumulator += min(now - previous_wall_time, 0.05)
            previous_wall_time = now
            while accumulator >= dt:
                controller.step()
                accumulator -= dt

            width, height = glfw.get_framebuffer_size(window)
            viewport = mujoco.MjrRect(0, 0, width, height)
            mujoco.mjv_updateScene(
                controller.model,
                controller.data,
                option,
                None,
                camera,
                mujoco.mjtCatBit.mjCAT_ALL.value,
                scene,
            )
            mujoco.mjr_render(viewport, scene, context)

            if now - last_title_update > 0.10:
                title = (
                    f"肩义手原型 | 模式: {MODE_LABELS[controller.mode]} | "
                    "W/S: 纵轴  A/D: 横轴  Space: 切换  R: 复位"
                )
                glfw.set_window_title(window, title)
                last_title_update = now

            glfw.swap_buffers(window)
            glfw.poll_events()
    except KeyboardInterrupt:
        # Normal terminal shutdown path; the finally block still flushes the CSV.
        pass
    finally:
        controller.pressed.clear()
        controller.close()
        glfw.destroy_window(window)
        glfw.terminate()
        print(f"日志已保存：{controller.log_path}")


if __name__ == "__main__":
    run()
