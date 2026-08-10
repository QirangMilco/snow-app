/**
 * 宠物动画舞台：canvas 逐帧绘制 Codex 精灵图，实现 9 态动画状态机。
 *
 * 状态来源：
 * - activity（主进程广播的 AI 活动状态）→ 基础状态
 *   idle→idle、busy→running、waiting→waiting、error→failed、completed→waving
 * - 首次出现播放一次 waving 打招呼。
 *
 * 窗口移动不使用任何 JS 坐标计算，而是由 CSS `-webkit-app-region: drag`
 * 交给操作系统做原生窗口拖拽（见 pet.css），天然 1:1 跟手、与 DPI 无关、
 * 绝无漂移。收起宠物在「设置 → 桌面宠物」中操作。
 */
import { useEffect, useRef, useState } from "react";
import type { PetActivityState, PetManifest } from "../../../preload/types/pets";
import { themeBgUrl } from "../../utils/themeBgUrl";
import {
  PET_FRAME_HEIGHT,
  PET_FRAME_WIDTH,
  PET_STATE_FPS,
  PET_STATE_ROWS,
  prepareSpritesheet,
  type PetSpriteState,
  type PreparedSpritesheet,
} from "./petSprites";

const ACTIVITY_TO_STATE: Record<PetActivityState, PetSpriteState> = {
  idle: "idle",
  busy: "running",
  review: "review",
  waiting: "waiting",
  error: "failed",
  completed: "waving",
};

type PetStageProps = {
  manifest: PetManifest;
  scale: number;
  activity: PetActivityState;
  /** OS 拖拽方向（左/右奔跑），null 表示未在拖拽 */
  dragState: PetSpriteState | null;
};

type AnimState = {
  state: PetSpriteState;
  oneShot: boolean;
  frame: number;
  elapsed: number;
};

export function PetStage({
  manifest,
  scale,
  activity,
  dragState,
}: PetStageProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sheetRef = useRef<PreparedSpritesheet | null>(null);
  const animRef = useRef<AnimState>({
    state: "idle",
    oneShot: false,
    frame: 0,
    elapsed: 0,
  });
  const baseStateRef = useRef<PetSpriteState>("idle");
  const greetingDoneRef = useRef(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const frameWidth = Math.round(PET_FRAME_WIDTH * scale);
  const frameHeight = Math.round(PET_FRAME_HEIGHT * scale);

  // 切换动画状态（非一次性动作才更新基础状态）。
  const switchState = (state: PetSpriteState, oneShot: boolean): void => {
    const anim = animRef.current;
    if (!oneShot) {
      baseStateRef.current = state;
    }
    if (anim.state === state && anim.oneShot === oneShot) {
      return;
    }
    anim.state = state;
    anim.oneShot = oneShot;
    anim.frame = 0;
    anim.elapsed = 0;
  };

  // ── 精灵图加载与预处理 ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    sheetRef.current = null;

    const image = new Image();
    image.onload = () => {
      if (cancelled) {
        return;
      }
      try {
        const columns = manifest.columns > 0 ? manifest.columns : 8;
        const rows = manifest.rows > 0 ? manifest.rows : 9;
        sheetRef.current = prepareSpritesheet(image, columns, rows);
        // 首次出现挥手打招呼。
        if (!greetingDoneRef.current) {
          greetingDoneRef.current = true;
          switchState("waving", true);
        }
      } catch {
        setLoadFailed(true);
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setLoadFailed(true);
      }
    };
    image.src = themeBgUrl(manifest.spritesheetPath);

    return () => {
      cancelled = true;
    };
  }, [manifest.spritesheetPath, manifest.columns, manifest.rows]);

  // ── AI 活动状态 → 基础动画状态 ─────────────────────────────────────
  useEffect(() => {
    switchState(ACTIVITY_TO_STATE[activity], false);
  }, [activity]);

  // ── OS 拖拽方向 → 覆盖为左/右奔跑，结束后回到基础状态 ─────────────
  useEffect(() => {
    const anim = animRef.current;
    if (dragState) {
      anim.state = dragState;
      anim.oneShot = false;
      anim.frame = 0;
      anim.elapsed = 0;
    } else {
      anim.state = baseStateRef.current;
      anim.oneShot = false;
      anim.frame = 0;
      anim.elapsed = 0;
    }
  }, [dragState]);

  // ── 动画主循环 ─────────────────────────────────────────────────────
  useEffect(() => {
    let rafId = 0;
    let lastTime: number | null = null;

    const drawFrame = (): void => {
      const canvas = canvasRef.current;
      const sheet = sheetRef.current;
      if (!canvas || !sheet) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      const anim = animRef.current;
      const row = PET_STATE_ROWS[anim.state];
      const frameCount = sheet.frameCounts[row] ?? 1;
      const frameIndex = Math.min(anim.frame, frameCount - 1);

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        sheet.canvas,
        frameIndex * sheet.frameWidth,
        row * sheet.frameHeight,
        sheet.frameWidth,
        sheet.frameHeight,
        (canvas.width - frameWidth) / 2,
        canvas.height - frameHeight,
        frameWidth,
        frameHeight
      );
    };

    const loop = (now: number): void => {
      const anim = animRef.current;
      const sheet = sheetRef.current;
      if (sheet) {
        const delta = lastTime === null ? 0 : (now - lastTime) / 1000;
        anim.elapsed += delta;

        const fps = PET_STATE_FPS[anim.state];
        const row = PET_STATE_ROWS[anim.state];
        const frameCount = sheet.frameCounts[row] ?? 1;
        const frameFloat = anim.elapsed * fps;

        if (anim.oneShot && frameFloat >= frameCount) {
          // 单次动作播完 → 回到基础状态。
          anim.oneShot = false;
          anim.state = baseStateRef.current;
          anim.elapsed = 0;
          anim.frame = 0;
        } else {
          anim.frame = Math.floor(frameFloat) % frameCount;
        }
        drawFrame();
      }
      lastTime = now;
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [frameWidth, frameHeight, manifest.id]);

  if (loadFailed) {
    return <div className="pet-stage-error">sprite load failed</div>;
  }

  return (
    <canvas
      ref={canvasRef}
      className="pet-stage-canvas"
      width={frameWidth}
      height={frameHeight}
    />
  );
}
